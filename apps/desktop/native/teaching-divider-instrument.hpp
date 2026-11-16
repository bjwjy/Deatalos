#pragma once
#include "ComponentEssentials.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <iomanip>
#include <sstream>

class HydraulicTeachingDifferentialGauge : public hopsan::ComponentQ {
    std::array<hopsan::Port*, 2> ports{};
    std::array<double*, 2> pressure{}, flow{}, wave{};
    double *difference;
public:
    static hopsan::Component *Creator() { return new HydraulicTeachingDifferentialGauge(); }
    void configure() {
        ports[0]=addPowerPort("A","NodeHydraulic");
        ports[1]=addPowerPort("B","NodeHydraulic");
        addOutputVariable("dp","Signed A minus B pressure","Pa",0,&difference);
    }
    void initialize() {
        for (size_t i=0; i<ports.size(); ++i) {
            pressure[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::Pressure);
            flow[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::Flow);
            wave[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::WaveVariable);
        }
        simulateOneTimestep();
    }
    void simulateOneTimestep() {
        // Independent dead-end measurement connections. No A-to-B path.
        for (size_t i=0; i<ports.size(); ++i) {
            *pressure[i]=*wave[i];
            *flow[i]=0;
        }
        *difference=*pressure[0]-*pressure[1];
    }
};

class HydraulicTeachingDividerCombiner : public hopsan::ComponentQ {
    const bool synchronizing;
    std::array<hopsan::Port*, 3> ports{};
    std::array<double*, 3> pressure{}, flow{}, wave{}, impedance{};
    double *shareA, *area, *coefficient, *density;
    double *correctionArea, *correctionDifferential, *correctionGate;

    explicit HydraulicTeachingDividerCombiner(bool sync) : synchronizing(sync) {}

    double capacity(int branch, double head, double share, double resistance) const {
        const double linear=*impedance[0]+share* *impedance[branch];
        return 2*head/(linear+std::sqrt(linear*linear+4*resistance*share*share*head));
    }
public:
    static hopsan::Component *Creator() { return new HydraulicTeachingDividerCombiner(false); }
    static hopsan::Component *Synchronizing() { return new HydraulicTeachingDividerCombiner(true); }
    void configure() {
        ports[0]=addPowerPort("P","NodeHydraulic");
        ports[1]=addPowerPort("A","NodeHydraulic");
        ports[2]=addPowerPort("B","NodeHydraulic");
        addInputVariable("shareA","Fraction carried by A in both directions","",.5,&shareA);
        addInputVariable("area","Fully open area per path","m^2",1e-5,&area);
        addInputVariable("Cq","Discharge coefficient","",.67,&coefficient);
        addInputVariable("rho","Oil density","kg/m^3",870,&density);
        if (synchronizing) {
            addInputVariable("correctionArea","End correction orifice area","m^2",2e-7,&correctionArea);
            addInputVariable("correctionDifferential","Start of branch pressure imbalance","Pa",3e5,&correctionDifferential);
            addInputVariable("correctionGate","Maximum balanced flow for correction","m^3/s",.35/60000,&correctionGate);
        }
    }
    void initialize() {
        if (!(*shareA>0 && *shareA<1 && *area>0 && *coefficient>0 && *density>0) ||
            (synchronizing && !(*correctionArea>0 && *correctionDifferential>0 && *correctionGate>0))) {
            stopSimulation("Invalid divider/combiner design");
            return;
        }
        for (size_t i=0; i<ports.size(); ++i) {
            pressure[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::Pressure);
            flow[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::Flow);
            wave[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::WaveVariable);
            impedance[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::CharImpedance);
        }
        simulateOneTimestep();
    }
    void simulateOneTimestep() {
        const double headA=*wave[0]-*wave[1], headB=*wave[0]-*wave[2];
        const double a=*shareA, b=1-a;
        const double resistance=.5 * *density/std::pow(*coefficient * *area,2);
        double total=0;
        // The pressure compensator throttles the easier path to the capacity
        // of the limiting path. Both paths must have head in the same direction.
        if ((headA>0 && headB>0) || (headA<0 && headB<0)) {
            total=std::copysign(std::min(capacity(1,std::abs(headA),a,resistance),
                                         capacity(2,std::abs(headB),b,resistance)),headA);
        }
        std::array<double,3> flows{{-total,a*total,b*total}};
        if (synchronizing && std::abs(total)<*correctionGate) {
            const int branch=std::abs(headA)>=std::abs(headB) ? 1 : 2;
            const double head=branch==1 ? headA : headB;
            const double other=branch==1 ? headB : headA;
            const double differential=*correctionDifferential;
            if (std::abs(head-other)>differential && std::copysign(1.0,head)*other>=-differential) {
                // Interpolate two passive solutions as paired flow collapses.
                // Both conserve mass. TLM dissipation is concave in these flows,
                // so their convex combination also dissipates hydraulic power.
                const double weight=(1-std::abs(total)/ *correctionGate) *
                    std::min(1.0,(std::abs(head-other)-differential)/differential);
                const double trimResistance=.5 * *density/std::pow(*coefficient * *correctionArea,2);
                const double trim=weight*std::copysign(capacity(branch,std::abs(head),1,trimResistance),head);
                for (double &q : flows) q*=1-weight;
                flows[branch]+=trim;
                flows[0]-=trim;
            }
        }
        for (size_t i=0; i<ports.size(); ++i) {
            const double p=*wave[i]+*impedance[i]*flows[i];
            if (!std::isfinite(p) || !std::isfinite(flows[i]) || p < -1e-5) {
                const char *cause=std::isfinite(p) && std::isfinite(flows[i]) ? "below_floor" : "nonfinite";
                const char *portNames[] = {"P","A","B"};
                std::ostringstream detail;
                detail << "HYD_PRESSURE " << portNames[i] << ' ' << cause << ' ' << std::setprecision(17) << p;
                stopSimulation(detail.str().c_str());
                return;
            }
        }
        for (size_t i=0; i<ports.size(); ++i) {
            *pressure[i]=*wave[i]+*impedance[i]*flows[i];
            *flow[i]=flows[i];
        }
    }
};
