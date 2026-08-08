#pragma once

#include <memory>

namespace Slic3r::GUI {

class Plater;

// Polls a private, per-process request directory from the GUI thread. The MCP
// server uses this queue to inspect and mutate the visible Plater without any
// desktop input automation. Keeping dispatch on the GUI thread also makes each
// request atomic with respect to normal wxWidgets event handling.
class LiveAutomation
{
public:
    LiveAutomation();
    ~LiveAutomation();

    LiveAutomation(const LiveAutomation&) = delete;
    LiveAutomation& operator=(const LiveAutomation&) = delete;

    void start(Plater* plater);
    void stop();

private:
    class Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace Slic3r::GUI
