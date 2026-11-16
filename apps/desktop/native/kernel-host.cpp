// E04B controlled native host. Derived from the Gate-R host; only fixed-library loading is extended.
#include "HopsanEssentials.h"
#include "ComponentSystem.h"
#include "Port.h"
#include <iostream>
#include <sstream>
#include <map>
#include <iomanip>
#include <cmath>
#include <stdexcept>
#include <vector>

using namespace hopsan;

static void writeJsonString(const std::string &value) {
    std::cout << '"';
    for (unsigned char ch : value) {
        if (ch == '"' || ch == '\\') std::cout << '\\' << ch;
        else if (ch < 32) std::cout << ' ';
        else std::cout << ch;
    }
    std::cout << '"';
}

int main(int argc, char **argv) {
    HopsanEssentials core;
    ComponentSystem *system = nullptr;
    std::map<std::string, Component*> components;
    struct MultiStart { std::string id, port, quantity; double value; };
    std::vector<MultiStart> multiStarts;
    bool initialized = false;
    double nativeStep = 0, acceptedTime = 0, observedTime = 0;
    unsigned long long nativeSteps = 0;
    std::vector<std::string> failureDetails;
    auto messages = [&]() {
        HString message, type, tag;
        bool error = false;
        while(core.checkMessage()) {
            core.getMessage(message, type, tag);
            if(type=="error" || type=="fatal") error=true;
            std::cerr << type.c_str() << ": " << message.c_str() << std::endl;
            const std::string detail = message.c_str();
            const auto stopped = detail.find("Simulation was stopped at t=");
            if (failureDetails.size() < 8 &&
                (type=="error" || type=="fatal" ||
                 (stopped != std::string::npos && detail.find(" : ", stopped) != std::string::npos)))
                failureDetails.push_back(detail.substr(0, 512));
        }
        return error;
    };
    if(argc < 2) return 2;
    for(int library=1; library<argc; ++library) {
        if(!core.loadExternalComponentLib(argv[library])) { messages(); return 2; }
    }
    std::cout << std::setprecision(17);
    std::cout << "{\"ready\":true,\"core\":\"" << core.getCoreVersion()
              << "\",\"compiler\":\"" << core.getCoreCompiler()
              << "\",\"is64bit\":" << (core.isCore64Bit()?"true":"false") << "}" << std::endl;
    std::string line;
    while(std::getline(std::cin, line)) {
        failureDetails.clear();
        std::istringstream in(line);
        std::string op, id, name, value, id2, port2;
        in >> op;
        try {
            if(op!="new" && op!="quit" && !system) throw std::runtime_error("no_model");
            if(op == "new") {
                if(system) { if(initialized) system->finalize(); core.removeComponent(system); }
                system = core.createComponentSystem();
                components.clear(); multiStarts.clear(); initialized=false;
                double step; if(!(in >> step) || !std::isfinite(step) || step<=0) throw std::runtime_error("invalid_step");
                system->setDesiredTimestep(step);
                nativeStep=step; acceptedTime=0; observedTime=0; nativeSteps=0;
            } else if(op == "add") {
                in >> id >> name;
                if(initialized || components.count(id)) throw std::runtime_error("invalid_add");
                auto c=core.createComponent(name.c_str());
                if(!c) throw std::runtime_error("unknown_component");
                c->setName(id.c_str()); system->addComponent(c); components[id]=c;
            } else if(op == "param") {
                in >> id >> name >> value;
                if(initialized) throw std::runtime_error("parameter_requires_reinit");
                if(!components.at(id)->setParameterValue(name.c_str(),value.c_str())) throw std::runtime_error("invalid_parameter");
            } else if(op == "start") {
                double v; in >> id >> name >> value >> v;
                if(initialized || !std::isfinite(v)) throw std::runtime_error("invalid_start");
                Port *port=components.at(id)->getPort(name.c_str());
                if (port && port->isMultiPort()) {
                    // The public string helper requires a connected node and
                    // otherwise silently skips multiports. Apply these after
                    // connect and before initialize so saved values are real.
                    multiStarts.push_back({id,name,value,v});
                } else {
                    components.at(id)->setDefaultStartValue(name.c_str(),value.c_str(),v);
                    // Hopsan refreshes the start-value parameter text with its default six significant digits.
                    // Retain the exact signal input through the public parameter API before initialize re-evaluates it.
                    if (port && port->getPortType()==ReadPortType && value=="Value") {
                        std::ostringstream precise; precise << std::setprecision(17) << v;
                        if (!components.at(id)->setParameterValue((name+"#Value").c_str(),precise.str().c_str()))
                            throw std::runtime_error("invalid_signal_start");
                    }
                }
            } else if(op == "connect") {
                in >> id >> name >> id2 >> port2;
                if(initialized || !system->connect(id.c_str(), name.c_str(), id2.c_str(), port2.c_str())) throw std::runtime_error("invalid_connection");
            } else if(op == "init") {
                double stop; in >> stop;
                for (const auto &start:multiStarts)
                    components.at(start.id)->setDefaultStartValue(start.port.c_str(),start.quantity.c_str(),start.value);
                if(initialized || !system->checkModelBeforeSimulation() || !system->initialize(0,stop))
                    throw std::runtime_error("initialize_failed");
                initialized=true;
                if(system->wasSimulationAborted()) throw std::runtime_error("initialize_failed");
            } else if(op == "advance") {
                double t; if(!(in >> t) || !initialized || !std::isfinite(t) || t<system->getTime()) throw std::runtime_error("invalid_time");
                const double budget=1e-8+std::abs(t)*1e-12;
                const auto steps=std::llround((t-acceptedTime)/nativeStep);
                if(steps<0 || std::abs(t-acceptedTime-steps*nativeStep)>budget) throw std::runtime_error("off_grid_time");
                system->simulate(t);
                if(system->wasSimulationAborted()) throw std::runtime_error("simulation_aborted");
                const double raw=system->getTime();
                if(!std::isfinite(raw) || std::abs(raw-t)>budget || std::llround((raw-acceptedTime)/nativeStep)!=steps)
                    throw std::runtime_error("native_clock_mismatch");
                for(const auto &entry:components) {
                    if(std::abs(entry.second->getTime()-t)>budget || entry.second->getTimestep()!=nativeStep)
                        throw std::runtime_error("component_clock_mismatch");
                }
                if(messages()) throw std::runtime_error("kernel_error");
                // Hopsan repeatedly adds h to double clocks. Re-anchor ONLY the
                // already-validated grid endpoint, never the physical state or h.
                // Keep the actually observed endpoint in every returned frame.
                for(const auto &entry:components) *entry.second->getTimePtr()=t;
                *system->getTimePtr()=t;
                acceptedTime=t; observedTime=raw; nativeSteps+=steps;
                std::cout << "{\"ok\":true,\"time\":" << observedTime << ",\"gridTime\":" << acceptedTime
                          << ",\"nativeSteps\":" << nativeSteps << ",\"advanceSteps\":" << steps << "}" << std::endl;
                continue;
            } else if(op == "frame") {
                // Bounded read-only transport batch. Simulation never advances here.
                if(!initialized) throw std::runtime_error("not_initialized");
                const double time=observedTime;
                std::vector<double> values;
                while(in >> id) {
                    if(!(in >> name >> value) || values.size()>=512) throw std::runtime_error("invalid_frame");
                    auto port=components.at(id)->getPort(name.c_str());
                    if(!port) throw std::runtime_error("unknown_port");
                    const int dataId=port->getNodeDataIdFromName(value.c_str());
                    if(dataId<0) throw std::runtime_error("unknown_variable");
                    const double v=*port->getNodeDataPtr(dataId);
                    if(!std::isfinite(v)) throw std::runtime_error("nonfinite_result");
                    values.push_back(v);
                }
                if(values.empty() || system->getTime()!=acceptedTime) throw std::runtime_error("invalid_frame");
                if(messages()) throw std::runtime_error("kernel_error");
                std::cout << "{\"ok\":true,\"time\":" << time << ",\"values\":[";
                for(size_t i=0; i<values.size(); ++i) { if(i) std::cout << ','; std::cout << values[i]; }
                std::cout << "]}" << std::endl; continue;
            } else if(op == "write" || op == "read") {
                in >> id >> name >> value;
                if(!initialized) throw std::runtime_error("not_initialized");
                auto port=components.at(id)->getPort(name.c_str());
                if(!port) throw std::runtime_error("unknown_port");
                int dataId=port->getNodeDataIdFromName(value.c_str());
                if(dataId<0) throw std::runtime_error("unknown_variable");
                if(op == "write") {
                    // Only unconnected signal inputs may be changed; never write physical results.
                    double v;
                    if(!(in >> v) || !std::isfinite(v) || value!="Value" || port->getPortType()!=ReadPortType || port->isConnected()) throw std::runtime_error("invalid_control");
                    *port->getNodeDataPtr(dataId)=v;
                }
                double v=*port->getNodeDataPtr(dataId);
                if(!std::isfinite(v)) throw std::runtime_error("nonfinite_result");
                std::cout << "{\"ok\":true,\"value\":" << v << ",\"time\":" << observedTime << "}" << std::endl;
                messages(); continue;
            } else if(op == "time") {
                std::cout << "{\"ok\":true,\"time\":" << observedTime << "}" << std::endl; continue;
            } else if(op == "end") {
                if(system) { if(initialized) system->finalize(); core.removeComponent(system); system=nullptr; initialized=false; components.clear(); }
            } else if(op == "quit") {
                break;
            } else throw std::runtime_error("unknown_operation");
            if(messages()) throw std::runtime_error("kernel_error");
            std::cout << "{\"ok\":true}" << std::endl;
        } catch(const std::exception &e) {
            messages();
            std::cout << "{\"ok\":false,\"error\":";
            writeJsonString(e.what());
            if (!failureDetails.empty()) {
                std::cout << ",\"details\":[";
                for (size_t i=0; i<failureDetails.size(); ++i) {
                    if (i) std::cout << ',';
                    writeJsonString(failureDetails[i]);
                }
                std::cout << ']';
            }
            std::cout << '}' << std::endl;
        }
    }
    if(system) { if(initialized) system->finalize(); core.removeComponent(system); }
    return 0;
}
