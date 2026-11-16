#pragma once
#include "ComponentEssentials.h"
#include <algorithm>
#include <array>
#include <cmath>

// Quasistatic load shuttle v0.1.0. The actual inlet pressures determine the
// shared seat opening fraction. Both paths are forward only, with no storage.
class HydraulicTeachingShuttle : public hopsan::ComponentQ {
    const bool requireBoth;
    std::array<hopsan::Port*,3> ports{};
    std::array<double*,3> p{}, q{}, c{}, z{};
    double *maximumArea, *coefficient, *density, *transition;
    double *minimumInlet=nullptr, *activationBand=nullptr;
    struct State { double qa, qb, pa, pb, pc; };

    static double inflow(double dc, double impedance, double k) {
        if (dc <= 0 || k <= 0) return 0;
        return 2*k*dc / (k*impedance + std::sqrt(k*k*impedance*impedance + 4*dc));
    }
    State atFraction(double f, double opening) const {
        const double k = *coefficient * *maximumArea * opening * std::sqrt(2 / *density);
        const double ca = *c[0], cb = *c[1], cc = *c[2];
        double low = cc, high = std::max(cc, std::max(ca, cb));
        if (*z[2] > 0) {
            for (int i=0; i<36; ++i) {
                const double pc = (low + high) / 2;
                const double sum = inflow(ca-pc,*z[0],f*k) + inflow(cb-pc,*z[1],(1-f)*k);
                if (pc < cc + *z[2]*sum) low = pc;
                else high = pc;
            }
        } else high = cc;
        const double pc = (low+high)/2;
        const double qa = inflow(ca-pc,*z[0],f*k), qb = inflow(cb-pc,*z[1],(1-f)*k);
        return {qa, qb, ca-*z[0]*qa, cb-*z[1]*qb, cc+*z[2]*(qa+qb)};
    }
    State select(double opening) const {
        State state=atFraction(1,opening);
        if (state.pa-state.pb >= *transition) return state;
        state=atFraction(0,opening);
        if (state.pa-state.pb <= -*transition) return state;
        double low=0, high=1;
        for (int i=0; i<30; ++i) {
            const double f=(low+high)/2;
            state=atFraction(f,opening);
            if ((2*f-1)* *transition < state.pa-state.pb) low=f;
            else high=f;
        }
        return state;
    }
    State enabledFlow() const {
        if (std::min(*c[0],*c[1]) <= *minimumInlet)
            return {0,0,*c[0],*c[1],*c[2]};
        State state=select(1);
        if (std::min(state.pa,state.pb) >= *minimumInlet + *activationBand) return state;
        // Close the loop on loaded inlet pressure, rather than switching on a
        // stale or unloaded signal. Increasing opening lowers inlet pressure.
        double low=0, high=1;
        for (int i=0; i<28; ++i) {
            const double opening=(low+high)/2;
            state=select(opening);
            const double signal=std::min(state.pa,state.pb)-*minimumInlet;
            if (opening * *activationBand < signal) low=opening;
            else high=opening;
        }
        return state;
    }
public:
    explicit HydraulicTeachingShuttle(bool both) : requireBoth(both) {}
    static hopsan::Component *Creator() { return new HydraulicTeachingShuttle(false); }
    static hopsan::Component *TwoPressure() { return new HydraulicTeachingShuttle(true); }
    void configure() {
        ports[0]=addPowerPort("A", "NodeHydraulic");
        ports[1]=addPowerPort("B", "NodeHydraulic");
        ports[2]=addPowerPort("C", "NodeHydraulic");
        addInputVariable("area", "Total open seat area", "m^2", 1e-5, &maximumArea);
        addInputVariable("Cq", "Discharge coefficient", "", .67, &coefficient);
        addInputVariable("rho", "Oil density", "kg/m^3", 870, &density);
        addInputVariable("transition", "Inlet differential for full selection", "Pa", 1000, &transition);
        if (requireBoth) {
            addInputVariable("minimumInlet", "Absolute inlet enable pressure", "Pa", 1.5e5, &minimumInlet);
            addInputVariable("activationBand", "Pressure rise for full enable", "Pa", 5e4, &activationBand);
        }
    }
    void initialize() {
        for (int i=0; i<3; ++i) {
            p[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::Pressure);
            q[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::Flow);
            c[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::WaveVariable);
            z[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::CharImpedance);
        }
        simulateOneTimestep();
    }
    void simulateOneTimestep() {
        if (!(*maximumArea > 0 && *density > 0 && *coefficient > 0 && *transition > 0) ||
            (requireBoth && !(*minimumInlet >= 0 && *activationBand > 0))) {
            stopSimulation("Invalid shuttle parameters"); return;
        }
        for (int i=0; i<3; ++i) {
            if (!std::isfinite(*c[i]) || !std::isfinite(*z[i]) || *z[i]<0) {
                stopSimulation("Invalid shuttle TLM boundary"); return;
            }
        }
        const State s=requireBoth ? enabledFlow() : select(1);
        if (!(std::isfinite(s.qa+s.qb) && s.pa >= -1e-5 && s.pb >= -1e-5 && s.pc >= -1e-5)) {
            stopSimulation("Shuttle outside non-cavitating domain"); return;
        }
        *p[0]=s.pa; *p[1]=s.pb; *p[2]=s.pc;
        *q[0]=-s.qa; *q[1]=-s.qb; *q[2]=s.qa+s.qb;
    }
};
