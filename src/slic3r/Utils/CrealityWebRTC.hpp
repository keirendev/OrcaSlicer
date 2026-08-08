#ifndef slic3r_CrealityWebRTC_hpp_
#define slic3r_CrealityWebRTC_hpp_

#include <string>

namespace Slic3r {
namespace CrealityWebRTC {

struct SignalingAnswer {
    std::string type;
    std::string sdp;
};

// Build the fixed LAN-only signaling endpoint from the configured print host.
// Returns an empty string and sets error when the host is not a private address
// or a local mDNS name.
std::string signaling_url(const std::string& print_host, std::string& error);

// Creality's local WebRTC endpoint exchanges base64-encoded JSON envelopes.
std::string encode_offer(const std::string& sdp, const std::string& token = {});
bool decode_answer(const std::string& body, SignalingAnswer& answer, std::string& error);

// WebKit may hide a host candidate behind an mDNS address. Replace only the
// address field of candidate lines and only when it is an mDNS host.
std::string replace_mdns_candidate(const std::string& sdp, const std::string& local_address);

} // namespace CrealityWebRTC
} // namespace Slic3r

#endif // slic3r_CrealityWebRTC_hpp_
