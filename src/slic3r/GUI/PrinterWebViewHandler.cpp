#include "PrinterWebViewHandler.hpp"

#include "I18N.hpp"
#include "PrinterWebView.hpp"
#include "slic3r/GUI/GUI_App.hpp"
#include "slic3r/GUI/Widgets/WebView.hpp"
#include "slic3r/Utils/PrintHost.hpp"
#include "slic3r/Utils/CrealityWebRTC.hpp"
#include "slic3r/Utils/Http.hpp"
#include "libslic3r/Preset.hpp"
#include "libslic3r/AppConfig.hpp"

#include <nlohmann/json.hpp>
#include <boost/asio.hpp>
#include <boost/filesystem/operations.hpp>
#include <boost/filesystem/path.hpp>
#include <boost/nowide/fstream.hpp>
#include <mutex>
#include <sstream>
#include <wx/filedlg.h>
#include <wx/filename.h>
#include <wx/process.h>
#include <wx/string.h>
#include <wx/utils.h>
#include <wx/weakref.h>

#ifdef __linux__
#include <webkit2/webkit2.h>
#endif

using json = nlohmann::json;

namespace Slic3r {
namespace GUI {

PrinterWebViewHandler::PrinterWebViewHandler(PrinterWebView& owner)
    : m_owner(owner)
{
}

PrinterWebViewHandler::~PrinterWebViewHandler() = default;

void PrinterWebViewHandler::on_loaded(wxWebViewEvent &evt)
{
}

void PrinterWebViewHandler::on_script_message(wxWebViewEvent &evt)
{
}

PrinterWebView& PrinterWebViewHandler::owner() const
{
    return m_owner;
}

wxWebView* PrinterWebViewHandler::browser() const
{
    return m_owner.m_browser;
}

namespace {

DynamicPrintConfig* get_active_printer_config()
{
    if (wxGetApp().preset_bundle == nullptr)
        return nullptr;

    return &wxGetApp().preset_bundle->printers.get_edited_preset().config;
}

std::string json_string(const json& node, const char* key)
{
    auto it = node.find(key);
    return (it != node.end() && it->is_string()) ? it->get<std::string>() : std::string();
}

std::string dump_json(const json& node)
{
    return node.dump(-1, ' ', false, json::error_handler_t::replace);
}

boost::filesystem::path path_from_utf8(const std::string& utf8_path)
{
#ifdef _WIN32
    const wxString wide_path = wxString::FromUTF8(utf8_path.c_str());
    return boost::filesystem::path(wide_path.ToStdWstring());
#else
    return boost::filesystem::path(utf8_path);
#endif
}

std::string filename_to_utf8(const boost::filesystem::path& path)
{
#ifdef _WIN32
    const wxString wx_filename(path.filename().c_str());
    const wxScopedCharBuffer utf8 = wx_filename.ToUTF8();
    return utf8.data() != nullptr ? std::string(utf8.data()) : std::string();
#else
    return path.filename().string();
#endif
}

#ifdef __linux__
std::string yaml_quote(const std::string& value)
{
    std::string result = "\"";
    result.reserve(value.size() + 2);
    for (char c : value) {
        if (c == '\\' || c == '"')
            result.push_back('\\');
        result.push_back(c);
    }
    result.push_back('"');
    return result;
}

std::string shell_quote(const std::string& value)
{
    std::string result = "'";
    for (char c : value) {
        if (c == '\'')
            result += "'\\''";
        else
            result.push_back(c);
    }
    result.push_back('\'');
    return result;
}

unsigned short reserve_loopback_port()
{
    boost::asio::io_context io;
    boost::asio::ip::tcp::acceptor acceptor(
        io, boost::asio::ip::tcp::endpoint(boost::asio::ip::address_v4::loopback(), 0));
    const unsigned short port = acceptor.local_endpoint().port();
    acceptor.close();
    return port;
}

class CrealityPrinterWebViewHandler final : public PrinterWebViewHandler {
public:
    explicit CrealityPrinterWebViewHandler(PrinterWebView& owner)
        : PrinterWebViewHandler(owner)
        , m_browser(browser())
    {
        // The current Linux WebKitGTK package exposes MediaSource but not
        // RTCPeerConnection. The Creality transport therefore runs in a
        // pinned loopback helper and passes the printer's native H.264 stream
        // to WebKit as fragmented MP4 over a loopback WebSocket. This avoids
        // both transcoding and the frame-rate cap of an MJPEG polling bridge.
        if (auto* web_view = static_cast<WebKitWebView*>(browser()->GetNativeBackend())) {
            if (WebKitSettings* settings = webkit_web_view_get_settings(web_view)) {
                webkit_settings_set_enable_media(settings, TRUE);
                webkit_settings_set_enable_mediasource(settings, TRUE);
                webkit_settings_set_media_playback_allows_inline(settings, TRUE);
                webkit_settings_set_media_playback_requires_user_gesture(settings, FALSE);
            }
        }
    }

    ~CrealityPrinterWebViewHandler() override
    {
        stop_helper();
        if (m_camera_handler_registered) {
            if (wxWebView* view = m_browser.get())
                view->RemoveScriptMessageHandler("orcaCamera");
        }
    }

    void on_loaded(wxWebViewEvent&) override
    {
        // Creality's bundled page may define its own `window.wx`. Keep camera
        // IPC on a dedicated namespace and restore it after SendAPIKey() has
        // reset WebKit user scripts/message handlers.
        if (!m_camera_handler_registered) {
            if (!browser()->AddScriptMessageHandler("orcaCamera")) {
                BOOST_LOG_TRIVIAL(error) << "Creality camera message handler registration failed";
            } else {
                m_camera_handler_registered = true;
            }
        }

        boost::nowide::ifstream script_file(resources_dir() + "/web/k1_camera_webrtc.js");
        if (!script_file) {
            BOOST_LOG_TRIVIAL(error) << "Creality camera bridge resource is missing";
            return;
        }
        std::string helper_error;
        const std::string helper_url = ensure_helper(helper_error);
        json bridge = {{"ok", !helper_url.empty()}};
        if (!helper_url.empty())
            bridge["url"] = helper_url;
        else
            bridge["error"] = helper_error.empty() ? "Camera bridge failed" : helper_error;

        std::ostringstream script;
        script << "window.__orcaCrealityCameraBridge=" << bridge.dump() << ";\n";
        script << script_file.rdbuf();
        const bool injected = WebView::RunScript(browser(), wxString::FromUTF8(script.str()));
        BOOST_LOG_TRIVIAL(info) << "Creality camera bridge injection " << (injected ? "succeeded" : "failed");
    }

    void on_script_message(wxWebViewEvent& evt) override
    {
        const wxScopedCharBuffer utf8 = evt.GetString().ToUTF8();
        const json request = json::parse(utf8.data() == nullptr ? "" : utf8.data(), nullptr, false);
        if (request.is_discarded() || !request.is_object()) {
            BOOST_LOG_TRIVIAL(debug) << "Creality camera bridge ignored a non-JSON script message";
            return;
        }

        const std::string method = json_string(request, "method");
        BOOST_LOG_TRIVIAL(debug) << "Creality camera bridge received script method "
                                 << (method.empty() ? "<empty>" : method);
        if (method != "creality_camera_start")
            return;

        const std::string request_id = json_string(request, "id");
        if (request_id.empty() || request_id.size() > 160) {
            send_result(request_id, false, {}, "Invalid camera bridge request");
            return;
        }

        std::string error;
        const std::string url = ensure_helper(error);
        BOOST_LOG_TRIVIAL(info) << "Creality camera helper request " << (url.empty() ? "failed" : "accepted");
        send_result(request_id, !url.empty(), url, error);
    }

private:
    std::string ensure_helper(std::string& error)
    {
        std::lock_guard<std::mutex> lock(m_helper_mutex);
        if (m_helper_pid > 0 && wxProcess::Exists(m_helper_pid)) {
            error.clear();
            return camera_url();
        }
        stop_helper_locked();

        DynamicPrintConfig* config = get_active_printer_config();
        const std::string print_host = config == nullptr ? std::string() : config->opt_string("print_host");
        const std::string signaling_url = CrealityWebRTC::signaling_url(print_host, error);
        if (signaling_url.empty())
            return {};

        const boost::filesystem::path helper_path = path_from_utf8(resources_dir()) / "camera" / "linux-x64" / "go2rtc";
        if (!boost::filesystem::is_regular_file(helper_path)) {
            error = "The packaged K1 camera helper is missing";
            return {};
        }

        try {
            m_helper_port = reserve_loopback_port();
            do {
                m_helper_rtsp_port = reserve_loopback_port();
            } while (m_helper_rtsp_port == m_helper_port);
        } catch (const std::exception&) {
            error = "Unable to reserve loopback ports for the K1 camera";
            return {};
        }

        const wxString temporary = wxFileName::CreateTempFileName("orca-k1-camera-");
        const wxScopedCharBuffer temporary_utf8 = temporary.ToUTF8();
        if (temporary_utf8.data() == nullptr) {
            error = "Unable to create the K1 camera helper configuration";
            return {};
        }
        m_helper_config = path_from_utf8(temporary_utf8.data());

        boost::nowide::ofstream output(m_helper_config.string(), std::ios::trunc);
        if (!output) {
            error = "Unable to write the K1 camera helper configuration";
            stop_helper_locked();
            return {};
        }
        output << "app:\n"
               << "  modules: [api, ws, rtsp, webrtc, mp4]\n"
               << "api:\n"
               << "  listen: \"127.0.0.1:" << m_helper_port << "\"\n"
               << "  allow_paths: [\"/\", \"/api/ws\"]\n"
               << "rtsp:\n"
               << "  listen: \"127.0.0.1:" << m_helper_rtsp_port << "\"\n"
               << "webrtc:\n"
               << "  listen: \"\"\n"
               << "  candidates: []\n"
               << "  ice_servers: []\n"
               << "streams:\n"
               << "  k1_source: " << yaml_quote("webrtc:" + signaling_url + "#format=creality") << "\n"
               << "preload:\n"
               << "  k1_source: \"video=h264\"\n"
               << "log:\n"
               << "  level: warn\n"
               << "  format: text\n";
        output.close();
        if (!output) {
            error = "Unable to finish the K1 camera helper configuration";
            stop_helper_locked();
            return {};
        }

        const std::string command = shell_quote(helper_path.string()) + " -config " + shell_quote(m_helper_config.string());
        m_helper_pid = wxExecute(wxString::FromUTF8(command), wxEXEC_ASYNC | wxEXEC_HIDE_CONSOLE);
        if (m_helper_pid <= 0) {
            error = "Unable to launch the packaged K1 camera helper";
            stop_helper_locked();
            return {};
        }

        BOOST_LOG_TRIVIAL(info) << "Creality camera helper started pid=" << m_helper_pid
                                << " loopback_port=" << m_helper_port;
        error.clear();
        return camera_url();
    }

    std::string camera_url() const
    {
        return "http://127.0.0.1:" + std::to_string(m_helper_port) +
               "/stream.html?src=k1_source&mode=mse&background=true";
    }

    void stop_helper()
    {
        std::lock_guard<std::mutex> lock(m_helper_mutex);
        stop_helper_locked();
    }

    void stop_helper_locked()
    {
        if (m_helper_pid > 0 && wxProcess::Exists(m_helper_pid)) {
            wxKillError kill_error = wxKILL_OK;
            wxKill(m_helper_pid, wxSIGTERM, &kill_error, wxKILL_CHILDREN);
        }
        m_helper_pid = 0;
        m_helper_port = 0;
        m_helper_rtsp_port = 0;
        if (!m_helper_config.empty()) {
            boost::system::error_code ec;
            boost::filesystem::remove(m_helper_config, ec);
            m_helper_config.clear();
        }
    }

    void send_result(const std::string& request_id, bool ok, const std::string& url, const std::string& error)
    {
        json detail = {{"id", request_id}, {"ok", ok}};
        if (ok)
            detail["url"] = url;
        else
            detail["error"] = error.empty() ? "Camera bridge failed" : error;
        const wxString script = wxString::FromUTF8(
            "window.dispatchEvent(new CustomEvent('orca:creality-camera-ready',{detail:" + detail.dump() + "}));");
        wxGetApp().CallAfter([browser = m_browser, script]() {
            wxWebView* view = browser.get();
            if (view != nullptr && !view->IsBeingDeleted())
                WebView::RunScript(view, script);
        });
    }

    wxWeakRef<wxWebView> m_browser;
    std::mutex m_helper_mutex;
    long m_helper_pid {0};
    unsigned short m_helper_port {0};
    unsigned short m_helper_rtsp_port {0};
    boost::filesystem::path m_helper_config;
    bool m_camera_handler_registered {false};
};
#endif

class ElegooPrinterWebViewHandler final : public PrinterWebViewHandler {
public:
    explicit ElegooPrinterWebViewHandler(PrinterWebView& owner)
        : PrinterWebViewHandler(owner)
    {
    }

    ~ElegooPrinterWebViewHandler() override
    {
        stop_upload = true;
        if (upload_thread.joinable())
            upload_thread.join();
    }

    void on_script_message(wxWebViewEvent &evt) override
    {
        const wxString message = evt.GetString();
        if (message.empty())
            return;

        json root = json::parse(message.ToUTF8().data(), nullptr, false);
        if (root.is_discarded() || !root.is_object())
            return;

        std::string request_id = json_string(root, "id");
        std::string method     = json_string(root, "method");
        json        params     = root.contains("params") && root["params"].is_object() ? root["params"] : json::object();

        if (method.empty()) {
            method = json_string(root, "command");
            if (params.empty() && root.contains("data") && root["data"].is_object())
                params = root["data"];
        }

        if (method == "open" || method == "common_openurl") {
            const std::string url = json_string(params, "url").empty() ? json_string(root, "url") : json_string(params, "url");
            if (!url.empty())
                wxLaunchDefaultBrowser(url);
            if (!request_id.empty())
                send_ipc_message("response", request_id, method, 0, "success");
            return;
        }

        if (method == "upload_file") {
            handle_upload_request(request_id, method, dump_json(params));
            return;
        }

        if (method == "open_file_dialog") {
            handle_open_file_dialog_request(request_id, method, dump_json(params));
            return;
        }

        if (method == "get_sn") {
            handle_get_sn_request(request_id, method);
            return;
        }
    }

private:
    void send_ipc_message(const char* type, const std::string& request_id, const std::string& method, int code,
                          const std::string& message, const std::string& data_json = "{}")
    {
        if (browser() == nullptr)
            return;

        json body = json::object();
        body["type"] = type;
        if (!request_id.empty())
            body["id"] = request_id;
        if (!method.empty())
            body["method"] = method;

        json data = json::parse(data_json, nullptr, false);
        if (data.is_discarded())
            data = json::object();
        body["data"] = std::move(data);

        if (std::string(type) == "response") {
            body["code"] = code;
            body["message"] = message;
        }

        const wxString payload = wxString::FromUTF8(dump_json(body));
        const wxString script = "if (typeof HandleStudio === 'function') { HandleStudio(" + payload + "); } else { window.postMessage(" + payload + ", '*'); }";
        wxGetApp().CallAfter([this, script]() {
            if (browser() != nullptr)
                WebView::RunScript(browser(), script);
        });
    }

    void handle_upload_request(const std::string& request_id, const std::string& method, const std::string& params_json)
    {
        if (upload_in_progress.exchange(true)) {
            send_ipc_message("response", request_id, method, 1, "Upload already in progress");
            return;
        }

        if (upload_thread.joinable())
            upload_thread.join();

        json params = json::parse(params_json, nullptr, false);
        if (params.is_discarded())
            params = json::object();

        std::string file_path = json_string(params, "filePath");
        std::string file_name = json_string(params, "fileName");

        if (file_path.empty()) {
            upload_in_progress = false;
            send_ipc_message("response", request_id, method, 1, "Missing filePath");
            return;
        }

        // HTML IPC passes UTF-8 strings; decode explicitly to avoid Windows codepage issues.
        boost::filesystem::path source_path = path_from_utf8(file_path);
        if (file_name.empty())
            file_name = filename_to_utf8(source_path);

        DynamicPrintConfig* config = get_active_printer_config();
        std::unique_ptr<PrintHost> print_host(config == nullptr ? nullptr : PrintHost::get_print_host(config));
        if (print_host == nullptr) {
            upload_in_progress = false;
            send_ipc_message("response", request_id, method, 1, "Could not get a valid Printer Host reference");
            return;
        }

        stop_upload = false;
        upload_thread = std::thread([this, request_id, method, file_path, file_name, source_path, print_host = std::move(print_host)]() mutable {
            std::string error_message;

            PrintHostUpload upload_data;
            upload_data.use_3mf      = false;
            upload_data.post_action  = PrintHostPostUploadAction::None;
            upload_data.source_path  = source_path;
            upload_data.upload_path  = path_from_utf8(file_name);

            const bool success = print_host->upload(
                std::move(upload_data),
                [this, request_id](Http::Progress progress, bool& cancel) {
                    cancel = stop_upload.load();
                    json data = {
                        {"uploadedBytes", static_cast<uint64_t>(progress.ulnow)},
                        {"totalBytes", static_cast<uint64_t>(progress.ultotal)}
                    };
                    send_ipc_message("event", request_id, "upload_progress", 0, "", dump_json(data));
                },
                [&error_message](wxString error) {
                    error_message = error.ToUTF8().data();
                },
                [this, request_id](wxString tag, wxString status) {
                    json data = {
                        {"tag", tag.ToUTF8().data()},
                        {"status", status.ToUTF8().data()}
                    };
                    send_ipc_message("event", request_id, "upload_info", 0, "", dump_json(data));
                });

            upload_in_progress = false;

            if (success) {
                json data = {
                    {"success", true},
                    {"filePath", file_path},
                    {"fileName", file_name}
                };
                send_ipc_message("response", request_id, method, 0, "success", dump_json(data));
            } else {
                if (error_message.empty())
                    error_message = "Upload failed";
                send_ipc_message("response", request_id, method, 1, error_message);
            }
        });
    }

    void handle_open_file_dialog_request(const std::string& request_id, const std::string& method, const std::string& params_json)
    {
        json params = json::parse(params_json, nullptr, false);
        if (params.is_discarded())
            params = json::object();

        const std::string filter = json_string(params, "filter").empty() ? "All files (*.*)|*.*" : json_string(params, "filter");

        wxWindow* parent = owner().GetParent();
        if (parent == nullptr)
            parent = wxGetApp().GetTopWindow();

        wxFileDialog open_file_dialog(parent, _L("Open File"), "", "", wxString::FromUTF8(filter), wxFD_OPEN | wxFD_FILE_MUST_EXIST);

        json data = json::object();
        data["files"] = json::array();
        if (open_file_dialog.ShowModal() != wxID_CANCEL)
            data["files"].push_back(open_file_dialog.GetPath().ToUTF8().data());

        send_ipc_message("response", request_id, method, 0, "success", dump_json(data));
    }

    void handle_get_sn_request(const std::string& request_id, const std::string& method)
    {
        // Panel always calls get_sn with a 10s IPC timeout. Answer immediately from
        // dev_sn / cache — do not spawn a thread or perform HTTP (panel uses URL sn on miss).
        std::string sn;
        if (DynamicPrintConfig* config = get_active_printer_config()) {
            const std::unique_ptr<PrintHost> host(PrintHost::get_print_host(config));
            if (host)
                sn = host->get_sn();
        }
        json data = { { "sn", sn } };
        send_ipc_message("response", request_id, method, 0, "success", dump_json(data));
    }

    std::atomic<bool> upload_in_progress { false };
    std::atomic<bool> stop_upload { false };
    std::thread       upload_thread;
};

} // namespace

std::unique_ptr<PrinterWebViewHandler> create_printer_webview_handler(PrinterWebView& owner)
{
    auto     cfg = get_active_printer_config();
    if(cfg == nullptr) return nullptr;
    
    const auto host_type = cfg->option<ConfigOptionEnum<PrintHostType>>("host_type")->value;
    switch (host_type)
    {
#ifdef __linux__
        case PrintHostType::htCrealityPrint:
            return std::make_unique<CrealityPrinterWebViewHandler>(owner);
#endif
        case PrintHostType::htElegooLink:
            return std::make_unique<ElegooPrinterWebViewHandler>(owner);
        default:
            return nullptr;
    }
}

} // GUI
} // Slic3r
