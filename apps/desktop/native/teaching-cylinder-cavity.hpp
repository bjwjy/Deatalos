// Liquid TLM and stroke-stop equations adapted from HydraulicCylinderC,
// Copyright 2017 Hopsan Group, Apache License, Version 2.0.
// https://www.apache.org/licenses/LICENSE-2.0
// This adapter tracks signed inventory for the original moving chambers.
#pragma once
#include "ComponentEssentials.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

class HydraulicTeachingCavityCylinder : public hopsan::ComponentC {
    struct Terminal { double *pressure, *flow, *wave, *impedance; };
    struct Chamber {
        hopsan::Port *port;
        double *area, *dead, *cavity;
        bool tracked=false, low=false;
        double inventory=0, volume=0, pistonWave=0, leakWave=0;
        std::vector<Terminal> terminals;
    };
    std::array<Chamber, 2> chambers{};
    hopsan::Port *shaft;
    double *stroke, *damping, *bulk, *leakage, *leakOut;
    double *position, *speed, *wave, *impedance, *mass;

    double volume(size_t side) const {
        const auto &c=chambers[side];
        const double travel=side==0 ? -*position : *stroke+*position;
        return *c.dead + *c.area*std::max(0.0, travel);
    }
    double liquidImpedance(const Chamber &c, double equivalentMass) const {
        const double area=*c.area;
        const double minimum=*bulk*mTimestep*mTimestep*area*area/(.1*equivalentMass);
        return (c.terminals.size()+2.0)*.5* *bulk/std::max(c.volume, minimum)*mTimestep/.9;
    }
    static double reflect(double incident, double average, double z, double flow) {
        return .1*incident + .9*(2*average-incident-2*z*flow);
    }
    void publishMechanics(const std::array<double,2> &z, double equivalentMass) {
        const double a=*chambers[0].area, b=*chambers[1].area;
        double stopWave=0, stopImpedance=0;
        const double penetration=-*position>*stroke ? *position+*stroke : -*position<0 ? *position : 0;
        if (penetration!=0) {
            const double z0=.1*equivalentMass/mTimestep;
            stopImpedance=2*z0;
            stopWave=.5*(z0*penetration/mTimestep+stopImpedance* *speed);
        }
        *wave=a*chambers[0].pistonWave-b*chambers[1].pistonWave+stopWave;
        *impedance=a*a*z[0]+b*b*z[1]+*damping+stopImpedance;
    }
public:
    static hopsan::Component *Creator() { return new HydraulicTeachingCavityCylinder; }
    void configure() {
        chambers[0].port=addPowerMultiPort("P1", "NodeHydraulic");
        chambers[1].port=addPowerMultiPort("P2", "NodeHydraulic");
        shaft=addPowerPort("P3", "NodeMechanic");
        addInputVariable("A_1", "Cap area", "m^2", .001, &chambers[0].area);
        addInputVariable("A_2", "Rod area", "m^2", .00065, &chambers[1].area);
        addInputVariable("V_1", "Cap dead volume", "m^3", .0003, &chambers[0].dead);
        addInputVariable("V_2", "Rod dead volume", "m^3", .0003, &chambers[1].dead);
        addInputVariable("s_l", "Stroke", "m", 1, &stroke);
        addInputVariable("B_p", "Piston viscous damping", "Ns/m", 1000, &damping);
        addInputVariable("Beta_e", "Liquid bulk modulus", "Pa", 1e9, &bulk);
        addInputVariable("c_leak", "Internal leakage coefficient", "LeakageCoefficient", 0, &leakage);
        addConstant("cavityAEnabled", "Track cap-side liquid shortage", "", false, chambers[0].tracked);
        addConstant("cavityBEnabled", "Track rod-side liquid shortage", "", false, chambers[1].tracked);
        addOutputVariable("cavityA", "Cap-side equivalent cavity", "m^3", 0, &chambers[0].cavity);
        addOutputVariable("cavityB", "Rod-side equivalent cavity", "m^3", 0, &chambers[1].cavity);
        addOutputVariable("q_leak", "Internal leakage flow", "m^3/s", 0, &leakOut);
    }
    void initialize() {
        position=getSafeNodeDataPtr(shaft, hopsan::NodeMechanic::Position);
        speed=getSafeNodeDataPtr(shaft, hopsan::NodeMechanic::Velocity);
        wave=getSafeNodeDataPtr(shaft, hopsan::NodeMechanic::WaveVariable);
        impedance=getSafeNodeDataPtr(shaft, hopsan::NodeMechanic::CharImpedance);
        mass=getSafeNodeDataPtr(shaft, hopsan::NodeMechanic::EquivalentMass);
        std::array<double,2> z, pressure;
        for (size_t i=0; i<chambers.size(); ++i) {
            auto &c=chambers[i];
            const auto count=c.port->getNumPorts();
            if (!count || !(*c.dead>0 && *c.area>0 && *bulk>0)) {
                stopSimulation("Cavity cylinder requires connected chambers and positive physical volume");
                return;
            }
            c.terminals.clear();
            for (size_t j=0; j<count; ++j)
                c.terminals.push_back({
                    getSafeMultiPortNodeDataPtr(c.port,j,hopsan::NodeHydraulic::Pressure,0),
                    getSafeMultiPortNodeDataPtr(c.port,j,hopsan::NodeHydraulic::Flow,0),
                    getSafeMultiPortNodeDataPtr(c.port,j,hopsan::NodeHydraulic::WaveVariable,0),
                    getSafeMultiPortNodeDataPtr(c.port,j,hopsan::NodeHydraulic::CharImpedance,0),
                });
            pressure[i]=getDefaultStartValue(c.port, hopsan::NodeHydraulic::Pressure);
            c.volume=volume(i);
            c.inventory=c.volume*pressure[i]/ *bulk;
            c.low=c.tracked && pressure[i]<=0;
            z[i]=c.low ? 0 : liquidImpedance(c,1);
            *c.cavity=std::max(0.0,-c.inventory);
            const double q=getDefaultStartValue(c.port,hopsan::NodeHydraulic::Flow)/count;
            for (const auto &t : c.terminals) {
                *t.pressure=pressure[i]; *t.flow=q; *t.wave=pressure[i]+z[i]*q; *t.impedance=z[i];
            }
            c.pistonWave=pressure[i]+z[i]* *speed* *c.area*(i==0 ? 1 : -1);
        }
        const double qLeak=*leakage*(pressure[0]-pressure[1]);
        chambers[0].leakWave=pressure[0]-z[0]*qLeak;
        chambers[1].leakWave=pressure[1]+z[1]*qLeak;
        *leakOut=qLeak;
        publishMechanics(z,1);
    }
    void simulateOneTimestep() {
        const double effectiveMass=*mass>0 ? *mass : 1;
        if (!std::isfinite(*position) || !std::isfinite(*speed) ||
            (!(*mass>0) && mTime>1.5*mTimestep)) {
            stopSimulation("Invalid cavity cylinder mechanical boundary");
            return;
        }
        const double oldZ=*chambers[0].terminals[0].impedance + *chambers[1].terminals[0].impedance;
        const double qLeak=*leakage*(chambers[0].leakWave-chambers[1].leakWave)/(1+*leakage*oldZ);
        std::array<double,2> z;
        for (size_t i=0; i<chambers.size(); ++i) {
            auto &c=chambers[i];
            const double nextVolume=volume(i);
            const double leak=(i==0 ? -1 : 1)*qLeak;
            const double swept=(i==0 ? 1 : -1)* *speed* *c.area;
            double flow=leak, highestFlow=std::abs(swept);
            bool touchesFloor=false;
            for (const auto &t : c.terminals) {
                flow+=*t.flow;
                highestFlow=std::max(highestFlow,std::abs(*t.flow));
                touchesFloor=touchesFloor || *t.pressure<=0;
            }
            if (c.tracked) c.inventory+=mTimestep*flow-(nextVolume-c.volume);
            c.volume=nextVolume;
            if (!std::isfinite(flow) || !std::isfinite(c.inventory) || c.inventory<=-c.volume) {
                stopSimulation("Cavity cylinder outside finite moving-chamber inventory");
                return;
            }
            z[i]=liquidImpedance(c,effectiveMass);
            const double localPressure=*bulk*std::max(0.0,c.inventory)/c.volume;
            const bool wasLow=c.low;
            c.low=c.tracked && (wasLow ? localPressure<=2*z[i]*highestFlow : touchesFloor || c.inventory<=0);
            double average=c.pistonWave+2*z[i]*swept+c.leakWave+2*z[i]*leak;
            for (const auto &t : c.terminals) average+=*t.wave+2*z[i]* *t.flow;
            average/=c.terminals.size()+2.0;
            if (c.tracked && !wasLow) {
                for (const auto &t : c.terminals)
                    c.low=c.low || reflect(*t.wave,average,z[i],*t.flow)<=0;
            }
            if (wasLow || c.low) {
                c.pistonWave=localPressure;
                c.leakWave=localPressure;
                for (const auto &t : c.terminals) *t.wave=localPressure;
            } else {
                c.pistonWave=reflect(c.pistonWave,average,z[i],swept);
                c.leakWave=reflect(c.leakWave,average,z[i],leak);
                for (const auto &t : c.terminals) *t.wave=reflect(*t.wave,average,z[i],*t.flow);
            }
            if (c.low) z[i]=0;
            for (const auto &t : c.terminals) *t.impedance=z[i];
            *c.cavity=std::max(0.0,-c.inventory);
        }
        *leakOut=qLeak;
        publishMechanics(z,effectiveMass);
    }
};
