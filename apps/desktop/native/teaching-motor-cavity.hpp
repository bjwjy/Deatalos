// Single-phase TLM equations adapted from HydraulicVolumeMultiPort and
// HydraulicFixedDisplacementMotorQ, Copyright 2017 Hopsan Group.
// Licensed under the Apache License, Version 2.0.
// https://www.apache.org/licenses/LICENSE-2.0
// This adaptation adds an inventory state and explicit zero-impedance handling.
#pragma once
#include "ComponentEssentials.h"
#include "ComponentUtilities.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

namespace teaching_cavity {
struct OilTerminal {
    double *pressure, *flow, *wave, *impedance;
};
}

// The declared fixed volume owns the shortage. It follows the stock TLM
// equations in liquid operation and a common pressure near the cavity floor.
class HydraulicTeachingMotorVolume : public hopsan::ComponentC {
    hopsan::Port *port;
    double *volume, *bulk, *damping, *cavity;
    std::vector<teaching_cavity::OilTerminal> terminals;
    double inventory=0;
    bool lowPressure=false;

    double liquidImpedance() const {
        return double(terminals.size()) * *bulk / (2 * *volume) * mTimestep / (1 - *damping);
    }
public:
    static hopsan::Component *Creator() { return new HydraulicTeachingMotorVolume; }
    void configure() {
        port=addPowerMultiPort("P1", "NodeHydraulic");
        addInputVariable("V", "Declared oil volume", "m^3", 1e-4, &volume);
        addInputVariable("Beta_e", "Oil bulk modulus", "Pa", 1e9, &bulk);
        addInputVariable("alpha", "Liquid TLM damping", "-", .1, &damping);
        addOutputVariable("cavity", "Equivalent cavity volume", "m^3", 0, &cavity);
        setDefaultStartValue(port, hopsan::NodeHydraulic::Flow, 0);
        setDefaultStartValue(port, hopsan::NodeHydraulic::Pressure, 1e5);
    }
    void initialize() {
        const size_t count=port->getNumPorts();
        if (!count || !(*volume>0) || !(*bulk>0) || !(*damping>=0 && *damping<1)) {
            stopSimulation("Motor cavity requires a positive declared volume and valid liquid compliance");
            return;
        }
        terminals.clear();
        for (size_t i=0; i<count; ++i) {
            terminals.push_back({
                getSafeMultiPortNodeDataPtr(port, i, hopsan::NodeHydraulic::Pressure, 0),
                getSafeMultiPortNodeDataPtr(port, i, hopsan::NodeHydraulic::Flow, 0),
                getSafeMultiPortNodeDataPtr(port, i, hopsan::NodeHydraulic::WaveVariable, 0),
                getSafeMultiPortNodeDataPtr(port, i, hopsan::NodeHydraulic::CharImpedance, 0),
            });
        }
        const double z=liquidImpedance();
        double sum=0;
        for (size_t i=0; i<count; ++i) {
            const auto &terminal=terminals[i];
            *terminal.pressure=getDefaultStartValue(port, hopsan::NodeHydraulic::Pressure, i);
            *terminal.flow=getDefaultStartValue(port, hopsan::NodeHydraulic::Flow, i);
            sum+=*terminal.pressure + z * *terminal.flow;
        }
        const double average=sum/double(count);
        inventory=average * *volume / *bulk;
        lowPressure=average<=0;
        *cavity=std::max(0.0, -inventory);
        for (const auto &terminal : terminals) {
            *terminal.wave=2*average - *terminal.pressure - z * *terminal.flow;
            *terminal.impedance=lowPressure ? 0 : z;
        }
    }
    void simulateOneTimestep() {
        const double z=liquidImpedance();
        double sumFlow=0, sumIncoming=0, maxFlow=0;
        bool touchesFloor=false;
        for (const auto &terminal : terminals) {
            const double q=*terminal.flow;
            if (!std::isfinite(q) || !std::isfinite(*terminal.pressure)) {
                stopSimulation("Motor cavity received a non-finite port value");
                return;
            }
            sumFlow+=q;
            sumIncoming+=*terminal.wave + 2*z*q;
            maxFlow=std::max(maxFlow, std::abs(q));
            touchesFloor=touchesFloor || *terminal.pressure<=0;
        }
        inventory+=mTimestep*sumFlow;
        if (!std::isfinite(inventory) || inventory<=-*volume) {
            stopSimulation("Motor cavity outside declared fixed-volume inventory domain");
            return;
        }
        const double pressure=std::max(0.0, inventory) * *bulk / *volume;
        *cavity=std::max(0.0, -inventory);
        if (lowPressure) {
            // Resume the liquid waves only when their local pressure spread
            // can fit above the floor. Their mean retains the same inventory.
            lowPressure=pressure<=2*z*maxFlow || pressure==0;
            for (const auto &terminal : terminals) {
                *terminal.wave=pressure;
                *terminal.impedance=lowPressure ? 0 : z;
            }
            return;
        }
        const double incomingAverage=sumIncoming/double(terminals.size());
        lowPressure=touchesFloor || inventory<=0;
        for (const auto &terminal : terminals) {
            const double reflected=2*incomingAverage - *terminal.wave - 2*z * *terminal.flow;
            const double next=*damping * *terminal.wave + (1 - *damping)*reflected;
            if (next<=0) lowPressure=true;
        }
        for (const auto &terminal : terminals) {
            const double reflected=2*incomingAverage - *terminal.wave - 2*z * *terminal.flow;
            *terminal.wave=lowPressure ? pressure : *damping * *terminal.wave + (1 - *damping)*reflected;
            *terminal.impedance=lowPressure ? 0 : z;
        }
    }
};

// Same rotary inertia and leakage equations as the liquid model. When the
// companion volume prescribes pressure (Z=0), displacement flow drives its
// inventory instead of being limited by a division through that impedance.
class HydraulicTeachingCavityMotor : public hopsan::ComponentQ {
    std::array<hopsan::Port*, 2> ports;
    std::array<teaching_cavity::OilTerminal, 2> oil;
    hopsan::Port *shaft;
    double *displacement, *damping, *leakage, *inertia;
    double *angle, *speed, *torque, *shaftWave, *shaftImpedance;
    hopsan::DoubleIntegratorWithDamping rotor;
public:
    static hopsan::Component *Creator() { return new HydraulicTeachingCavityMotor; }
    void configure() {
        addInputVariable("D_m", "Displacement", "m^3/rev", 5e-5, &displacement);
        addInputVariable("B_m", "Viscous friction", "Nm/rad", 0, &damping);
        addInputVariable("C_lm", "Leakage coefficient", "LeakageCoefficient", 0, &leakage);
        addInputVariable("J_m", "Rotary inertia", "MomentOfInertia", .1, &inertia);
        ports[0]=addPowerPort("P1", "NodeHydraulic");
        ports[1]=addPowerPort("P2", "NodeHydraulic");
        shaft=addPowerPort("P3", "NodeMechanicRotational");
    }
    void initialize() {
        for (size_t i=0; i<ports.size(); ++i) {
            oil[i]={
                getSafeNodeDataPtr(ports[i], hopsan::NodeHydraulic::Pressure),
                getSafeNodeDataPtr(ports[i], hopsan::NodeHydraulic::Flow),
                getSafeNodeDataPtr(ports[i], hopsan::NodeHydraulic::WaveVariable),
                getSafeNodeDataPtr(ports[i], hopsan::NodeHydraulic::CharImpedance),
            };
        }
        angle=getSafeNodeDataPtr(shaft, hopsan::NodeMechanicRotational::Angle);
        speed=getSafeNodeDataPtr(shaft, hopsan::NodeMechanicRotational::AngularVelocity);
        torque=getSafeNodeDataPtr(shaft, hopsan::NodeMechanicRotational::Torque);
        shaftWave=getSafeNodeDataPtr(shaft, hopsan::NodeMechanicRotational::WaveVariable);
        shaftImpedance=getSafeNodeDataPtr(shaft, hopsan::NodeMechanicRotational::CharImpedance);
        rotor.initialize(mTimestep, 0, 0, 0, 0);
    }
    void simulateOneTimestep() {
        const double za=*oil[0].impedance, zb=*oil[1].impedance;
        const double ca=*oil[0].wave, cb=*oil[1].wave;
        const double swept=*displacement/(2*hopsan::pi);
        const double cl=*leakage;
        const double coupling=1/(cl*(za+zb)+1);
        const double pa0=(cl*zb+1)*coupling*ca + cl*coupling*za*cb;
        const double pb0=(cl*za+1)*coupling*cb + cl*coupling*zb*ca;
        const double shaftDamping=*damping + za*swept*swept + zb*swept*swept + *shaftImpedance;
        rotor.setDamping(shaftDamping / *inertia * mTimestep);
        rotor.integrateWithUndo((pa0*swept - pb0*swept - *shaftWave) / *inertia);
        const double omega=rotor.valueFirst();
        double qa=-swept*omega;
        bool limitedA=false, limitedB=false;
        if (za>0) {
            const double lower=-pa0/coupling/za;
            limitedA=qa<=lower;
            qa=std::max(qa, lower);
        }
        if (zb>0) {
            const double upper=pb0/coupling/zb;
            limitedB=qa>=upper;
            limitedA=limitedA && qa<=upper;
            qa=std::min(qa, upper);
        }
        // At a liquid-side flow bound the corresponding pressure is exactly
        // zero. In the cavity regime the volume itself prescribes pressure.
        const double pa=limitedA ? 0 : pa0+coupling*za*qa;
        const double pb=limitedB ? 0 : pb0-coupling*zb*qa;
        const double flow=qa-cl*(pa-pb);
        if (!std::isfinite(omega) || !std::isfinite(rotor.valueSecond()) ||
            !std::isfinite(flow) || !std::isfinite(pa) || !std::isfinite(pb) || pa<0 || pb<0) {
            stopSimulation("Cavity motor produced a non-finite state");
            return;
        }
        *oil[0].pressure=pa;
        *oil[1].pressure=pb;
        *oil[0].flow=flow;
        *oil[1].flow=-flow;
        *angle=rotor.valueSecond();
        *speed=omega;
        *torque=*shaftWave+omega * *shaftImpedance;
    }
};
