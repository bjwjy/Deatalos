#pragma once
#include "ComponentEssentials.h"
#include <algorithm>
#include <array>
#include <cmath>

class HydraulicTeachingHystereticPressure : public hopsan::ComponentQ {
    const bool unloading;
    std::array<hopsan::Port*, 3> ports{};
    std::array<double*, 3> pressure{}, flow{}, wave{}, impedance{};
    double *on, *off, *reference, *area, *coefficient, *density, *state;
    double *analog, *low, *high, *voltage;
    bool active=false;

    explicit HydraulicTeachingHystereticPressure(bool isUnloadValve) : unloading(isUnloadValve) {}

    double bypassFlow() const {
        const double head=*wave[1]-*wave[2];
        if (head<=0) return 0;
        const double resistance=.5 * *density/std::pow(*coefficient * *area,2);
        const double linear=*impedance[1]+*impedance[2];
        return 2*head/(linear+std::sqrt(linear*linear+4*resistance*head));
    }
public:
    static hopsan::Component *Switch() { return new HydraulicTeachingHystereticPressure(false); }
    static hopsan::Component *UnloadValve() { return new HydraulicTeachingHystereticPressure(true); }
    void configure() {
        ports[0]=addPowerPort(unloading ? "X" : "H","NodeHydraulic");
        addInputVariable("on","Rising trip pressure","Pa",2.5e6,&on);
        addInputVariable("off","Falling reset pressure","Pa",2e6,&off);
        if (unloading) {
            ports[1]=addPowerPort("P","NodeHydraulic");
            ports[2]=addPowerPort("T","NodeHydraulic");
            addInputVariable("area","Open bypass area","m^2",1e-5,&area);
            addInputVariable("Cq","Discharge coefficient","",.67,&coefficient);
            addInputVariable("rho","Oil density","kg/m^3",870,&density);
        } else {
            addInputVariable("reference","Project pressure offset","Pa",0,&reference);
            addInputVariable("analog","Analog output mode","",0,&analog);
            addInputVariable("low","Pressure at zero volts","Pa",1e6,&low);
            addInputVariable("high","Pressure at ten volts","Pa",5e6,&high);
            addOutputVariable("OUT","Control voltage","V",0,&voltage);
        }
        addOutputVariable("active","Contact closed or bypass open","",0,&state);
    }
    void initialize() {
        if (!(*on>*off && *off>=0) || (unloading && !(*area>0 && *coefficient>0 && *density>0))) {
            stopSimulation("Invalid hysteretic pressure component design");
            return;
        }
        if (!unloading && *analog != 0 && !(*high > *low)) {
            stopSimulation("Invalid analog pressure range");
            return;
        }
        for (size_t i=0; i<(unloading ? ports.size() : 1); ++i) {
            pressure[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::Pressure);
            flow[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::Flow);
            wave[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::WaveVariable);
            impedance[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::CharImpedance);
        }
        active=false;
        simulateOneTimestep();
    }
    void simulateOneTimestep() {
        if (!std::isfinite(*wave[0]) || *wave[0]<-1e-5) {
            stopSimulation("Pressure sensing outside non-cavitating domain");
            return;
        }
        // The sensing leg is dead-ended. Use the return pressure for the
        // current valve state so changing bypass flow does not anticipate a trip.
        const double datum=unloading
            ? *wave[2]+*impedance[2]*(active ? bypassFlow() : 0)
            : *reference;
        const double sensed=*wave[0]-datum;
        active=active ? sensed>*off : sensed>=*on;
        *state=active ? 1 : 0;
        if (!unloading) {
            const double fraction=*analog != 0
                ? std::max(0.0,std::min(1.0,(sensed-*low)/(*high-*low)))
                : *state;
            *voltage=10*fraction;
        }
        *pressure[0]=*wave[0];
        *flow[0]=0;
        if (unloading) {
            const double q=active ? bypassFlow() : 0;
            const double p=*wave[1]-*impedance[1]*q;
            const double t=*wave[2]+*impedance[2]*q;
            if (!std::isfinite(q) || !std::isfinite(p) || !std::isfinite(t) || p < -1e-5 || t < -1e-5) {
                stopSimulation("Teaching unloading valve outside non-cavitating domain");
                return;
            }
            *flow[1]=-q;
            *flow[2]=q;
            *pressure[1]=p;
            *pressure[2]=t;
        }
    }
};

class HydraulicTeachingVoltageDisplacement : public hopsan::ComponentSignal {
    double *voltage, *minimum, *maximum, *displacement, *sampledVoltage;
public:
    static hopsan::Component *Creator() { return new HydraulicTeachingVoltageDisplacement(); }
    void configure() override {
        addInputVariable("U","Control voltage","V",0,&voltage);
        addInputVariable("minimum","Minimum displacement","m3/rev",4e-6,&minimum);
        addInputVariable("maximum","Maximum displacement","m3/rev",16e-6,&maximum);
        addOutputVariable("D","Displacement command","m3/rev",4e-6,&displacement);
        addOutputVariable("sample","Voltage used for displacement","V",0,&sampledVoltage);
    }
    void initialize() override { simulateOneTimestep(); }
    void simulateOneTimestep() override {
        if (!std::isfinite(*voltage) || *voltage<0 || *voltage>10 || !(*maximum>*minimum && *minimum>0)) {
            stopSimulation("Invalid motor displacement voltage or range");
            return;
        }
        *sampledVoltage=*voltage;
        *displacement=*voltage==10 ? *maximum : *minimum+(*maximum-*minimum)*(*voltage/10);
    }
};
