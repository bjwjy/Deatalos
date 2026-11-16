#pragma once
#include "ComponentEssentials.h"
#include <algorithm>
#include <cmath>
#include <vector>

// Lumped fixed-volume compliance on one ideal net. Negative liquid
// inventory relative to the pressure floor represents a vapor cavity.
class HydraulicTeachingOilStorage : public hopsan::ComponentC {
    struct Terminal { double *pressure, *flow, *wave, *impedance; };
    hopsan::Port *port;
    std::vector<Terminal> terminals;
    double *volume, *bulkModulus, *initialPressure, *cavityOut;
    double inventory=0;

    void publish(bool initialize) {
        const double pressure=(*bulkModulus / *volume)*std::max(0.0,inventory);
        if (!std::isfinite(pressure) || !std::isfinite(inventory) || inventory<=-*volume) {
            stopSimulation("Teaching oil storage outside finite liquid/cavity domain");
            return;
        }
        *cavityOut=std::max(0.0,-inventory);
        for (const auto &terminal:terminals) {
            *terminal.wave=pressure;
            *terminal.impedance=0;
            if (initialize) *terminal.pressure=pressure;
        }
    }
public:
    static hopsan::Component *Creator() { return new HydraulicTeachingOilStorage(); }
    void configure() {
        port=addPowerMultiPort("P","NodeHydraulic");
        addInputVariable("V","Declared equivalent oil volume","m^3",.00015,&volume);
        addInputVariable("Beta","Oil bulk modulus","Pa",1e9,&bulkModulus);
        addInputVariable("p0","Initial native pressure","Pa",1e5,&initialPressure);
        addOutputVariable("cavity","Equivalent vapor cavity volume","m^3",0,&cavityOut);
    }
    void initialize() {
        if (!(*volume>0 && *bulkModulus>0 && *initialPressure>=0)) {
            stopSimulation("Invalid teaching oil storage");
            return;
        }
        terminals.clear();
        for (size_t i=0; i<port->getNumPorts(); ++i) {
            terminals.push_back({
                getSafeMultiPortNodeDataPtr(port,i,hopsan::NodeHydraulic::Pressure,0),
                getSafeMultiPortNodeDataPtr(port,i,hopsan::NodeHydraulic::Flow,0),
                getSafeMultiPortNodeDataPtr(port,i,hopsan::NodeHydraulic::WaveVariable,0),
                getSafeMultiPortNodeDataPtr(port,i,hopsan::NodeHydraulic::CharImpedance,0),
            });
        }
        inventory=(*volume / *bulkModulus)* *initialPressure;
        publish(true);
    }
    void simulateOneTimestep() {
        double flow=0;
        for (const auto &terminal:terminals) flow+=*terminal.flow;
        inventory+=mTimestep*flow;
        publish(false);
    }
};
