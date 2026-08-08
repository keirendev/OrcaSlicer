#include "CrealityWebRTC.hpp"

#include <algorithm>
#include <cctype>
#include <sstream>
#include <vector>

#include <boost/asio/ip/address.hpp>
#include <boost/beast/core/detail/base64.hpp>
#include <boost/algorithm/string/classification.hpp>
#include <boost/algorithm/string/predicate.hpp>
#include <boost/algorithm/string/replace.hpp>
#include <boost/algorithm/string/split.hpp>
#include <nlohmann/json.hpp>

namespace Slic3r {
namespace CrealityWebRTC {

namespace {

constexpr size_t MAX_SIGNALING_BODY_SIZE = 1024 * 1024;

std::string trim(std::string value)
{
    auto first = std::find_if_not(value.begin(), value.end(), [](unsigned char c) { return std::isspace(c); });
    auto last = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char c) { return std::isspace(c); }).base();
    if (first >= last)
        return {};
    return std::string(first, last);
}

std::string configured_host(std::string value)
{
    value = trim(std::move(value));
    const auto scheme = value.find("://");
    if (scheme != std::string::npos)
        value.erase(0, scheme + 3);

    const auto path = value.find_first_of("/?#");
    if (path != std::string::npos)
        value.erase(path);

    if (value.find('@') != std::string::npos)
        return {};

    if (!value.empty() && value.front() == '[') {
        const auto end = value.find(']');
        if (end == std::string::npos)
            return {};
        return value.substr(1, end - 1);
    }

    const auto colon = value.rfind(':');
    if (colon != std::string::npos && value.find(':') == colon)
        value.erase(colon);
    return trim(std::move(value));
}

bool is_trusted_lan_host(const std::string& host)
{
    if (host.empty())
        return false;

    boost::system::error_code ec;
    const auto address = boost::asio::ip::make_address(host, ec);
    if (!ec) {
        if (address.is_loopback())
            return true;
        if (address.is_v4()) {
            const auto bytes = address.to_v4().to_bytes();
            return bytes[0] == 10 ||
                   (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
                   (bytes[0] == 192 && bytes[1] == 168) ||
                   (bytes[0] == 169 && bytes[1] == 254);
        }
        const auto bytes = address.to_v6().to_bytes();
        return (bytes[0] & 0xfe) == 0xfc || // RFC 4193 unique local addresses.
               (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80); // fe80::/10 link-local.
    }

    std::string lower = host;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return std::tolower(c); });
    if (lower.size() <= 6 || !boost::algorithm::ends_with(lower, ".local"))
        return false;
    return std::all_of(lower.begin(), lower.end(), [](unsigned char c) {
        return std::isalnum(c) || c == '-' || c == '.';
    });
}

std::string base64_encode(const std::string& input)
{
    std::string output;
    output.resize(boost::beast::detail::base64::encoded_size(input.size()));
    output.resize(boost::beast::detail::base64::encode(output.data(), input.data(), input.size()));
    return output;
}

bool base64_decode(const std::string& input, std::string& output)
{
    std::string normalized;
    normalized.reserve(input.size());
    for (unsigned char c : input) {
        if (!std::isspace(c))
            normalized.push_back(static_cast<char>(c));
    }
    if (normalized.empty() || normalized.size() > MAX_SIGNALING_BODY_SIZE)
        return false;

    output.resize(boost::beast::detail::base64::decoded_size(normalized.size()));
    const auto result = boost::beast::detail::base64::decode(output.data(), normalized.data(), normalized.size());
    if (result.second != normalized.size()) {
        output.clear();
        return false;
    }
    output.resize(result.first);
    return true;
}

} // namespace

std::string signaling_url(const std::string& print_host, std::string& error)
{
    const std::string host = configured_host(print_host);
    if (!is_trusted_lan_host(host)) {
        error = "The Creality camera host is not a trusted LAN address";
        return {};
    }
    error.clear();
    const bool ipv6 = host.find(':') != std::string::npos;
    return std::string("http://") + (ipv6 ? "[" + host + "]" : host) + ":8000/call/webrtc_local";
}

std::string encode_offer(const std::string& sdp, const std::string& token)
{
    nlohmann::json envelope = {{"type", "offer"}, {"sdp", sdp}};
    if (!token.empty())
        envelope["token"] = token;
    return base64_encode(envelope.dump());
}

bool decode_answer(const std::string& body, SignalingAnswer& answer, std::string& error)
{
    answer = {};
    std::string decoded;
    if (!base64_decode(body, decoded)) {
        error = "The printer returned an invalid base64 WebRTC answer";
        return false;
    }

    const nlohmann::json envelope = nlohmann::json::parse(decoded, nullptr, false);
    if (envelope.is_discarded() || !envelope.is_object()) {
        error = "The printer returned an invalid WebRTC answer envelope";
        return false;
    }

    const auto type = envelope.find("type");
    const auto sdp = envelope.find("sdp");
    if (type == envelope.end() || !type->is_string() || type->get<std::string>() != "answer" ||
        sdp == envelope.end() || !sdp->is_string() || sdp->get_ref<const std::string&>().empty()) {
        error = "The printer returned an incomplete WebRTC answer";
        return false;
    }

    answer.type = "answer";
    answer.sdp = sdp->get<std::string>();
    error.clear();
    return true;
}

std::string replace_mdns_candidate(const std::string& sdp, const std::string& local_address)
{
    if (local_address.empty())
        return sdp;

    std::istringstream input(sdp);
    std::ostringstream output;
    std::string line;
    bool first = true;
    while (std::getline(input, line)) {
        if (!first)
            output << '\n';
        first = false;

        std::vector<std::string> fields;
        boost::algorithm::split(fields, line, boost::is_any_of(" "), boost::token_compress_on);
        if (fields.size() > 4 && boost::algorithm::starts_with(fields[0], "a=candidate:") &&
            boost::algorithm::iends_with(fields[4], ".local")) {
            fields[4] = local_address;
            for (size_t i = 0; i < fields.size(); ++i) {
                if (i != 0)
                    output << ' ';
                output << fields[i];
            }
        } else {
            output << line;
        }
    }
    if (!sdp.empty() && sdp.back() == '\n')
        output << '\n';
    return output.str();
}

} // namespace CrealityWebRTC
} // namespace Slic3r
