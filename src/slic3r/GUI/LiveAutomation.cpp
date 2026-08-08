#include "LiveAutomation.hpp"

#include "GUI_App.hpp"
#include "GUI_Utils.hpp"
#include "PartPlate.hpp"
#include "Plater.hpp"

#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/Utils.hpp"

#include <boost/filesystem.hpp>
#include <boost/algorithm/string/case_conv.hpp>
#include <boost/log/trivial.hpp>
#include <boost/uuid/random_generator.hpp>
#include <boost/uuid/uuid_io.hpp>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <wx/timer.h>
#include <wx/utils.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <vector>

#ifndef _WIN32
#include <sys/stat.h>
#endif

namespace fs = boost::filesystem;

namespace Slic3r::GUI {

namespace {

constexpr int      protocol_version = 1;
constexpr uintmax_t max_request_bytes = 64 * 1024;

std::string random_id()
{
    return boost::uuids::to_string(boost::uuids::random_generator()());
}

std::string sha256_hex(const std::string& value)
{
    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(value.data()), value.size(), digest);
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (unsigned char byte : digest)
        out << std::setw(2) << static_cast<unsigned int>(byte);
    return out.str();
}

nlohmann::json vec3_json(const Vec3d& value)
{
    return nlohmann::json::array({value.x(), value.y(), value.z()});
}

nlohmann::json bbox_json(const BoundingBoxf3& box)
{
    if (!box.defined)
        return nullptr;
    return {
        {"minMm", vec3_json(box.min)},
        {"maxMm", vec3_json(box.max)},
        {"sizeMm", vec3_json(box.size())},
        {"centerMm", vec3_json(box.center())}
    };
}

void set_owner_only_permissions(const fs::path& path, bool directory)
{
#ifndef _WIN32
    if (::chmod(path.string().c_str(), directory ? 0700 : 0600) != 0)
        BOOST_LOG_TRIVIAL(warning) << "Unable to restrict live automation permissions for " << path.string();
#else
    (void) path;
    (void) directory;
#endif
}

void write_json_atomic(const fs::path& target, const nlohmann::json& value)
{
    const fs::path temporary = target.string() + "." + random_id() + ".tmp";
    {
        std::ofstream output(temporary.string(), std::ios::binary | std::ios::trunc);
        if (!output)
            throw std::runtime_error("Unable to create live automation response: " + temporary.string());
        output << value.dump(2) << '\n';
        if (!output)
            throw std::runtime_error("Unable to write live automation response: " + temporary.string());
    }
    set_owner_only_permissions(temporary, false);
    boost::system::error_code error;
#ifdef _WIN32
    fs::remove(target, error);
    error.clear();
#endif
    fs::rename(temporary, target, error);
    if (error) {
        fs::remove(temporary);
        throw std::runtime_error("Unable to publish live automation response: " + error.message());
    }
}

nlohmann::json read_json_file(const fs::path& path)
{
    std::ifstream input(path.string(), std::ios::binary);
    if (!input)
        throw std::runtime_error("Unable to read live automation request");
    return nlohmann::json::parse(input);
}

class RequestError : public std::runtime_error
{
public:
    RequestError(std::string code, std::string message)
        : std::runtime_error(std::move(message)), code(std::move(code))
    {}

    std::string code;
};

} // namespace

class LiveAutomation::Impl : public wxEvtHandler
{
public:
    Impl() : m_timer(this)
    {
        Bind(wxEVT_TIMER, &Impl::on_timer, this);
    }

    ~Impl() override
    {
        stop();
    }

    void start(Plater* plater)
    {
        if (m_started || plater == nullptr)
            return;
        try {
            if (data_dir().empty())
                throw std::runtime_error("OrcaSlicer data directory is unavailable");
            m_plater     = plater;
            m_session_id = random_id();
            m_token      = random_id() + random_id();
            m_root       = fs::path(data_dir()) / "automation";
            m_session_root = m_root / ("live-" + m_session_id);
            m_request_dir  = m_session_root / "requests";
            m_response_dir = m_session_root / "responses";
            m_descriptor   = m_root / "live-session.json";

            fs::create_directories(m_request_dir);
            fs::create_directories(m_response_dir);
            set_owner_only_permissions(m_root, true);
            set_owner_only_permissions(m_session_root, true);
            set_owner_only_permissions(m_request_dir, true);
            set_owner_only_permissions(m_response_dir, true);

            nlohmann::json descriptor = {
                {"protocolVersion", protocol_version},
                {"pid", wxGetProcessId()},
                {"sessionId", m_session_id},
                {"token", m_token},
                {"sessionRoot", m_session_root.string()},
                {"startedAtUnixMs", std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::system_clock::now().time_since_epoch()).count()}
            };
            write_json_atomic(m_descriptor, descriptor);
            m_started = true;
            m_timer.Start(100);
            BOOST_LOG_TRIVIAL(info) << "Live MCP automation ready: session=" << m_session_id;
        } catch (const std::exception& error) {
            boost::system::error_code ignored;
            if (!m_session_root.empty())
                fs::remove_all(m_session_root, ignored);
            m_plater = nullptr;
            BOOST_LOG_TRIVIAL(error) << "Live MCP automation is unavailable: " << error.what();
        }
    }

    void stop()
    {
        if (!m_started)
            return;
        m_timer.Stop();

        try {
            if (fs::exists(m_descriptor)) {
                const nlohmann::json descriptor = read_json_file(m_descriptor);
                if (descriptor.value("sessionId", std::string()) == m_session_id)
                    fs::remove(m_descriptor);
            }
            fs::remove_all(m_session_root);
        } catch (const std::exception& error) {
            BOOST_LOG_TRIVIAL(warning) << "Failed to clean live automation session: " << error.what();
        }

        m_started = false;
        m_plater   = nullptr;
    }

private:
    nlohmann::json state() const
    {
        if (m_plater == nullptr)
            throw RequestError("not_ready", "The OrcaSlicer Plater is not ready");

        Model& model = m_plater->model();
        PartPlateList& plate_list = m_plater->get_partplate_list();
        nlohmann::json result = {
            {"protocolVersion", protocol_version},
            {"sessionId", m_session_id},
            {"pid", wxGetProcessId()},
            {"project", {
                {"name", into_u8(m_plater->get_project_name())},
                {"path", into_u8(m_plater->get_project_filename(".3mf"))},
                {"dirty", m_plater->is_project_dirty()}
            }},
            {"activePlateIndex", plate_list.get_curr_plate_index()},
            {"plateCount", plate_list.get_plate_count()},
            {"objectCount", model.objects.size()},
            {"instanceCount", 0},
            {"plates", nlohmann::json::array()},
            {"objects", nlohmann::json::array()}
        };

        if (wxGetApp().preset_bundle != nullptr) {
            result["presets"] = {
                {"printer", wxGetApp().preset_bundle->printers.get_edited_preset().name},
                {"process", wxGetApp().preset_bundle->prints.get_edited_preset().name},
                {"filaments", wxGetApp().preset_bundle->filament_presets}
            };
        }

        for (int plate_index = 0; plate_index < plate_list.get_plate_count(); ++plate_index) {
            PartPlate* plate = plate_list.get_plate(plate_index);
            const Vec2d size = plate->get_size();
            nlohmann::json slice = {
                {"valid", plate->is_slice_result_valid()},
                {"gcodePath", nullptr},
                {"gcodeExists", false}
            };
            if (plate->is_slice_result_valid()) {
                const std::string gcode = plate->get_gcode_filename();
                if (!gcode.empty()) {
                    slice["gcodePath"] = gcode;
                    boost::system::error_code error;
                    const bool exists = fs::is_regular_file(gcode, error);
                    slice["gcodeExists"] = exists;
                    if (exists) {
                        slice["gcodeBytes"] = fs::file_size(gcode, error);
                        if (!error)
                            slice["gcodeModifiedUnix"] = fs::last_write_time(gcode, error);
                    }
                }
            }
            result["plates"].push_back({
                {"index", plate_index},
                {"name", plate->get_plate_name()},
                {"locked", plate->is_locked()},
                {"sizeMm", nlohmann::json::array({size.x(), size.y()})},
                {"instanceCount", 0},
                {"instances", nlohmann::json::array()},
                {"slice", std::move(slice)}
            });
        }

        size_t instance_count = 0;
        for (size_t object_index = 0; object_index < model.objects.size(); ++object_index) {
            ModelObject* object = model.objects[object_index];
            nlohmann::json object_json = {
                {"index", object_index},
                {"id", object->id().id},
                {"name", object->name},
                {"sourcePath", object->input_file},
                {"printable", object->printable},
                {"facets", object->facets_count()},
                {"rawBoundingBox", bbox_json(object->raw_mesh_bounding_box())},
                {"instances", nlohmann::json::array()}
            };

            for (size_t instance_index = 0; instance_index < object->instances.size(); ++instance_index) {
                ModelInstance* instance = object->instances[instance_index];
                const int plate_index = plate_list.find_instance_belongs(
                    static_cast<int>(object_index), static_cast<int>(instance_index));
                constexpr double radians_to_degrees = 57.2957795130823208768;
                const Vec3d rotation = instance->get_rotation() * radians_to_degrees;
                nlohmann::json instance_json = {
                    {"index", instance_index},
                    {"id", instance->id().id},
                    {"plateIndex", plate_index},
                    {"printable", instance->is_printable()},
                    {"boundingBox", bbox_json(object->instance_bounding_box(instance_index))},
                    {"transform", {
                        {"offsetMm", vec3_json(instance->get_offset())},
                        {"rotationDeg", vec3_json(rotation)},
                        {"scale", vec3_json(instance->get_scaling_factor())},
                        {"mirror", vec3_json(instance->get_mirror())}
                    }}
                };
                object_json["instances"].push_back(instance_json);
                if (plate_index >= 0 && plate_index < plate_list.get_plate_count()) {
                    nlohmann::json reference = {
                        {"objectIndex", object_index},
                        {"objectId", object->id().id},
                        {"instanceIndex", instance_index},
                        {"instanceId", instance->id().id}
                    };
                    result["plates"][plate_index]["instances"].push_back(reference);
                    result["plates"][plate_index]["instanceCount"] =
                        result["plates"][plate_index]["instanceCount"].get<size_t>() + 1;
                }
                ++instance_count;
            }
            result["objects"].push_back(std::move(object_json));
        }
        result["instanceCount"] = instance_count;
        result["stateToken"] = sha256_hex(result.dump());
        return result;
    }

    void require_expected_state(const nlohmann::json& params) const
    {
        const std::string expected = params.value("expectedStateToken", std::string());
        if (expected.empty())
            throw RequestError("expected_state_required", "expectedStateToken is required for live mutations");
        const std::string actual = state().at("stateToken").get<std::string>();
        if (expected != actual)
            throw RequestError("state_conflict", "The live OrcaSlicer plate changed; inspect it again before retrying");
    }

    nlohmann::json dispatch(const std::string& action, const nlohmann::json& params)
    {
        if (action == "state")
            return state();

        require_expected_state(params);
        if (action == "clear") {
            const std::string scope = params.value("scope", "current_plate");
            if (scope == "current_plate")
                m_plater->remove_curr_plate_all();
            else if (scope == "all_models")
                m_plater->delete_all_objects_from_model();
            else
                throw RequestError("invalid_scope", "scope must be current_plate or all_models");
            return {{"cleared", scope}, {"state", state()}};
        }

        if (action == "import_stl") {
            const std::string source = params.value("path", std::string());
            const fs::path path(source);
            if (source.empty() || !path.is_absolute() || !fs::is_regular_file(path) ||
                boost::algorithm::to_lower_copy(path.extension().string()) != ".stl")
                throw RequestError("invalid_stl", "path must be an existing absolute .stl file");
            const std::vector<size_t> loaded = m_plater->load_files(
                std::vector<fs::path>{path}, LoadStrategy::LoadModel | LoadStrategy::Silence, false);
            if (loaded.empty())
                throw RequestError("import_failed", "OrcaSlicer did not load any model from the STL");
            return {{"importedObjectIndexes", loaded}, {"sourcePath", path.string()}, {"state", state()}};
        }

        if (action == "save_project") {
            const std::string destination = params.value("path", std::string());
            const bool overwrite = params.value("overwrite", false);
            const fs::path path(destination);
            if (destination.empty() || !path.is_absolute() ||
                boost::algorithm::to_lower_copy(path.extension().string()) != ".3mf")
                throw RequestError("invalid_project_path", "path must be an absolute .3mf file");
            if (!fs::is_directory(path.parent_path()))
                throw RequestError("missing_parent", "The project output directory does not exist");
            if (fs::exists(path) && !overwrite)
                throw RequestError("output_exists", "The project output exists; set overwrite to replace it");
            if (m_plater->export_3mf(path, SaveStrategy::Silence) < 0)
                throw RequestError("save_failed", "OrcaSlicer failed to export the live project");
            return {{"savedPath", path.string()}, {"state", state()}};
        }

        if (action == "print_artifact") {
            PartPlateList& plates = m_plater->get_partplate_list();
            PartPlate* plate = plates.get_curr_plate();
            if (!plate->has_printable_instances())
                throw RequestError("empty_plate", "The active plate has no printable instances");
            if (!plate->is_slice_result_valid() || !plate->is_valid_gcode_file())
                throw RequestError("slice_required", "Slice the active plate successfully before preparing a live print");
            return {
                {"gcodePath", plate->get_gcode_filename()},
                {"plateIndex", plates.get_curr_plate_index()},
                {"projectName", into_u8(m_plater->get_project_name())},
                {"state", state()}
            };
        }

        throw RequestError("unknown_action", "Unknown live automation action: " + action);
    }

    void process_request(const fs::path& request_path)
    {
        const std::string request_id = request_path.stem().string();
        nlohmann::json response = {
            {"protocolVersion", protocol_version},
            {"id", request_id},
            {"ok", false}
        };
        try {
            if (fs::file_size(request_path) > max_request_bytes)
                throw RequestError("request_too_large", "Live automation requests are limited to 64 KiB");
            const nlohmann::json request = read_json_file(request_path);
            if (request.value("protocolVersion", 0) != protocol_version)
                throw RequestError("protocol_mismatch", "Unsupported live automation protocol version");
            if (request.value("id", std::string()) != request_id)
                throw RequestError("invalid_request_id", "Request ID does not match its filename");
            if (request.value("token", std::string()) != m_token)
                throw RequestError("unauthorized", "Invalid live automation session token");
            const std::string action = request.value("action", std::string());
            const nlohmann::json params = request.value("params", nlohmann::json::object());
            response["result"] = dispatch(action, params);
            response["ok"] = true;
        } catch (const RequestError& error) {
            response["error"] = {{"code", error.code}, {"message", error.what()}};
        } catch (const std::exception& error) {
            response["error"] = {{"code", "internal_error"}, {"message", error.what()}};
            BOOST_LOG_TRIVIAL(error) << "Live automation request failed: " << error.what();
        }

        try {
            write_json_atomic(m_response_dir / (request_id + ".json"), response);
        } catch (const std::exception& error) {
            BOOST_LOG_TRIVIAL(error) << error.what();
        }
        boost::system::error_code ignored;
        fs::remove(request_path, ignored);
    }

    void on_timer(wxTimerEvent&)
    {
        if (!m_started || !fs::is_directory(m_request_dir))
            return;
        try {
            std::vector<fs::path> requests;
            for (const fs::directory_entry& entry : fs::directory_iterator(m_request_dir)) {
                if (fs::is_regular_file(entry.path()) && entry.path().extension() == ".json")
                    requests.push_back(entry.path());
            }
            std::sort(requests.begin(), requests.end());
            if (requests.size() > 8)
                requests.resize(8);
            for (const fs::path& request : requests)
                process_request(request);
        } catch (const std::exception& error) {
            BOOST_LOG_TRIVIAL(error) << "Live automation polling failed: " << error.what();
        }
    }

    wxTimer  m_timer;
    Plater*  m_plater {nullptr};
    bool     m_started {false};
    std::string m_session_id;
    std::string m_token;
    fs::path m_root;
    fs::path m_session_root;
    fs::path m_request_dir;
    fs::path m_response_dir;
    fs::path m_descriptor;
};

LiveAutomation::LiveAutomation() : m_impl(std::make_unique<Impl>()) {}
LiveAutomation::~LiveAutomation() = default;

void LiveAutomation::start(Plater* plater)
{
    m_impl->start(plater);
}

void LiveAutomation::stop()
{
    m_impl->stop();
}

} // namespace Slic3r::GUI
