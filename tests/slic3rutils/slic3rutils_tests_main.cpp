#include <catch2/catch_all.hpp>

#include "slic3r/Utils/Http.hpp"
#include "slic3r/Utils/OrcaCloudServiceAgent.hpp"
#include "slic3r/Utils/CrealityWebRTC.hpp"

namespace {

nlohmann::json flat_session_json(const nlohmann::json& fields)
{
    nlohmann::json session = {
        {"access_token", "test-token"},
        {"user_id", "test-user-id"}
    };
    session.update(fields);
    return session;
}

nlohmann::json nested_session_json(const nlohmann::json& metadata)
{
    return {
        {"access_token", "test-token"},
        {"user", {
            {"id", "test-user-id"},
            {"user_metadata", metadata}
        }}
    };
}

std::string resolved_display_name(const nlohmann::json& session)
{
    Slic3r::OrcaCloudServiceAgent agent("");
    REQUIRE(agent.set_user_session(session, false));
    return agent.get_user_nickname();
}

} // namespace

TEST_CASE("Creality WebRTC signaling is restricted to LAN hosts", "[CrealityWebRTC]")
{
    std::string error;
    CHECK(Slic3r::CrealityWebRTC::signaling_url("http://192.168.50.42/", error) ==
          "http://192.168.50.42:8000/call/webrtc_local");
    CHECK(error.empty());
    CHECK(Slic3r::CrealityWebRTC::signaling_url("k1-max.local:4408", error) ==
          "http://k1-max.local:8000/call/webrtc_local");
    CHECK(Slic3r::CrealityWebRTC::signaling_url("https://example.com", error).empty());
    CHECK_FALSE(error.empty());
}

TEST_CASE("Creality WebRTC offer and answer envelopes round trip", "[CrealityWebRTC]")
{
    const std::string offer = Slic3r::CrealityWebRTC::encode_offer("offer-sdp");
    CHECK(offer == "eyJzZHAiOiJvZmZlci1zZHAiLCJ0eXBlIjoib2ZmZXIifQ==");

    // eyJ0eXBlIjoiYW5zd2VyIiwic2RwIjoiYW5zd2VyLXNkcCJ9
    Slic3r::CrealityWebRTC::SignalingAnswer answer;
    std::string error;
    CHECK(Slic3r::CrealityWebRTC::decode_answer(
        "eyJ0eXBlIjoiYW5zd2VyIiwic2RwIjoiYW5zd2VyLXNkcCJ9", answer, error));
    CHECK(answer.type == "answer");
    CHECK(answer.sdp == "answer-sdp");
    CHECK_FALSE(Slic3r::CrealityWebRTC::decode_answer("not-base64", answer, error));
    CHECK_FALSE(error.empty());
    CHECK_FALSE(Slic3r::CrealityWebRTC::decode_answer("e30=", answer, error)); // {}
    CHECK_FALSE(Slic3r::CrealityWebRTC::decode_answer(
        "eyJzZHAiOiIiLCJ0eXBlIjoiYW5zd2VyIn0=", answer, error)); // empty SDP
    CHECK_FALSE(Slic3r::CrealityWebRTC::decode_answer(
        "eyJzZHAiOiJvZmZlci1zZHAiLCJ0eXBlIjoib2ZmZXIifQ==", answer, error));
}

TEST_CASE("Creality WebRTC replaces only mDNS candidate addresses", "[CrealityWebRTC]")
{
    const std::string sdp =
        "v=0\n"
        "a=candidate:1 1 UDP 2122260223 host-name.local 50000 typ host\n"
        "a=candidate:2 1 UDP 2122260223 192.168.50.4 50001 typ host\n";
    const std::string normalized = Slic3r::CrealityWebRTC::replace_mdns_candidate(sdp, "192.168.50.10");
    CHECK(normalized.find("192.168.50.10 50000") != std::string::npos);
    CHECK(normalized.find("192.168.50.4 50001") != std::string::npos);
    CHECK(Slic3r::CrealityWebRTC::replace_mdns_candidate(sdp, {}).find("host-name.local") != std::string::npos);
}

TEST_CASE("Check SSL certificates paths", "[Http][NotWorking]") {
    
    Slic3r::Http g = Slic3r::Http::get("https://github.com/");
    
    unsigned status = 0;
    g.on_error([&status](std::string, std::string, unsigned http_status) {
        status = http_status;
    });
    
    g.on_complete([&status](std::string /* body */, unsigned http_status){
        status = http_status;
    });
    
    g.perform_sync();
    
    REQUIRE(status == 200);
}

TEST_CASE("Orca cloud flat session resolves display name consistently", "[OrcaCloudServiceAgent]")
{
    CHECK(resolved_display_name(flat_session_json({
        {"username", "orca_username"},
        {"display_name", "Display Name"},
        {"nickname", "Nickname"}
    })) == "Display Name");

    CHECK(resolved_display_name(flat_session_json({
        {"username", "orca_username"},
        {"nickname", "Nickname"}
    })) == "Nickname");

    CHECK(resolved_display_name(flat_session_json({
        {"username", "orca_username"},
        {"full_name", "Full Name"}
    })) == "Full Name");

    CHECK(resolved_display_name(flat_session_json({
        {"username", "orca_username"},
        {"name", "Provider Name"}
    })) == "Provider Name");

    CHECK(resolved_display_name(flat_session_json({
        {"username", "orca_username"}
    })) == "orca_username");
}

TEST_CASE("Orca cloud nested session resolves display name consistently", "[OrcaCloudServiceAgent]")
{
    CHECK(resolved_display_name(nested_session_json({
        {"username", "orca_username"},
        {"display_name", "Display Name"},
        {"nickname", "Nickname"}
    })) == "Display Name");

    CHECK(resolved_display_name(nested_session_json({
        {"username", "orca_username"},
        {"nickname", "Nickname"}
    })) == "Nickname");

    CHECK(resolved_display_name(nested_session_json({
        {"username", "orca_username"},
        {"full_name", "Full Name"}
    })) == "Full Name");

    CHECK(resolved_display_name(nested_session_json({
        {"username", "orca_username"},
        {"name", "Provider Name"}
    })) == "Provider Name");

    CHECK(resolved_display_name(nested_session_json({
        {"username", "orca_username"}
    })) == "orca_username");
}

TEST_CASE("Http digest authentication", "[Http][NotWorking]") {
    Slic3r::Http g = Slic3r::Http::get("https://httpbingo.org/digest-auth/auth/guest/guest");

    g.auth_digest("guest", "guest");

    unsigned status = 0;
    g.on_error([&status](std::string, std::string, unsigned http_status) {
        status = http_status;
    });

    g.on_complete([&status](std::string /* body */, unsigned http_status){
        status = http_status;
    });

    g.perform_sync();

    REQUIRE(status == 200);
}

TEST_CASE("Http basic authentication", "[Http][NotWorking]") {
    Slic3r::Http g = Slic3r::Http::get("https://httpbingo.org/basic-auth/guest/guest");

    g.auth_basic("guest", "guest");

    unsigned status = 0;
    g.on_error([&status](std::string, std::string, unsigned http_status) {
        status = http_status;
    });

    g.on_complete([&status](std::string /* body */, unsigned http_status){
        status = http_status;
    });

    g.perform_sync();

    REQUIRE(status == 200);
}
