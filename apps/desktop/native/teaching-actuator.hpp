#pragma once
#include "ComponentEssentials.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <iomanip>
#include <sstream>

// One generalized mechanical coordinate. A and B exchange swept volume
// with the explicit oil storage in the mapping. The sign of B is reversed.
class HydraulicTeachingActuator : public hopsan::ComponentQ {
    enum class Mode { Spring, Cushioned, Rotary };
    const Mode mode;
    const int portCount;
    std::array<hopsan::Port*,2> ports{};
    std::array<double*,2> pressure{}, flow{}, wave{}, impedance{};
    std::array<double*,2> sweep{}, cushionLength{}, cushionArea{};
    double *limit, *inertia, *damping, *load, *reference, *initialPosition, *initialRate;
    double *spring=nullptr, *preload=nullptr, *density=nullptr, *coefficient=nullptr;
    double *positionOut, *rateOut, *effortOut;
    double position=0, rate=0;

    double swept(int i) const {
        return i==0 ? *sweep[0] : -*sweep[1];
    }
    double cushionResistance(bool forward) const {
        if (mode!=Mode::Cushioned) return 0;
        const int outlet=forward ? 1 : 0;
        const double length=*cushionLength[outlet];
        if (length<=0) return 0;
        const double distance=forward ? *limit-position : position;
        const double insertion=std::max(0.0,std::min(1.0,1-distance/length));
        const double loss=insertion/(*coefficient * *cushionArea[outlet]);
        // Convert the discharge orifice law to generalized effort:
        // |F| = S * rho/(2 Cq^2 A^2) * (S |v|)^2.
        return 0.5 * *density * loss*loss * std::pow(std::abs(swept(outlet)),3);
    }
    void publish(double sweptRate, double resistance) {
        std::array<double,2> acceptedPressure{}, inflow{};
        double effort=0;
        for (int i=0; i<portCount; ++i) {
            inflow[i]=swept(i)*sweptRate;
            acceptedPressure[i]=*wave[i]-*impedance[i]*inflow[i];
            const double cushionDrop=inflow[i]<0 ? resistance*sweptRate*sweptRate/std::abs(swept(i)) : 0;
            const double workingPressure=acceptedPressure[i]+cushionDrop;
            if (!std::isfinite(inflow[i]) || !std::isfinite(workingPressure) ||
                acceptedPressure[i]<-1e-5 || workingPressure-*reference>70e6+1e-5) {
                const double differential=workingPressure-*reference;
                const char *cause=!std::isfinite(inflow[i]) || !std::isfinite(workingPressure) ? "nonfinite"
                    : acceptedPressure[i]<-1e-5 ? "below_floor" : "above_limit";
                std::ostringstream detail;
                detail << "HYD_PRESSURE " << (i==0 ? "A" : "B") << ' ' << cause << ' '
                       << std::setprecision(17) << acceptedPressure[i] << ' ' << differential;
                stopSimulation(detail.str().c_str());
                return;
            }
            effort+=swept(i)*(workingPressure-*reference);
        }
        if (!std::isfinite(effort)) {
            stopSimulation("Invalid teaching actuator effort"); return;
        }
        for (int i=0; i<portCount; ++i) {
            *pressure[i]=acceptedPressure[i];
            *flow[i]=-inflow[i];
        }
        *positionOut=position; *rateOut=rate; *effortOut=effort;
    }
public:
    explicit HydraulicTeachingActuator(Mode m) : mode(m), portCount(m==Mode::Spring ? 1 : 2) {}
    static hopsan::Component *SpringCylinder() { return new HydraulicTeachingActuator(Mode::Spring); }
    static hopsan::Component *CushionedCylinder() { return new HydraulicTeachingActuator(Mode::Cushioned); }
    static hopsan::Component *Rotary() { return new HydraulicTeachingActuator(Mode::Rotary); }
    void configure() {
        const bool rotary=mode==Mode::Rotary;
        const char *sweepUnit=rotary ? "m^3/rad" : "m^2";
        ports[0]=addPowerPort("A","NodeHydraulic");
        addInputVariable("sweepA","Inlet swept volume per coordinate",sweepUnit,.001,&sweep[0]);
        if (portCount==2) {
            ports[1]=addPowerPort("B","NodeHydraulic");
            addInputVariable("sweepB","Outlet swept volume per coordinate",sweepUnit,.00065,&sweep[1]);
        }
        addInputVariable("limit","Upper travel limit",rotary ? "rad" : "m",.1,&limit);
        addInputVariable("inertia","Moving mass or rotary inertia",rotary ? "kg m^2" : "kg",20,&inertia);
        addInputVariable("damping","Viscous mechanical damping",rotary ? "N m s/rad" : "N s/m",1000,&damping);
        addInputVariable("load","Constant load opposing positive motion",rotary ? "N m" : "N",0,&load);
        addInputVariable("reference","Mechanical reference pressure","Pa",0,&reference);
        addInputVariable("initialPosition","Initial coordinate",rotary ? "rad" : "m",0,&initialPosition);
        addInputVariable("initialRate","Initial speed",rotary ? "rad/s" : "m/s",0,&initialRate);
        if (mode==Mode::Spring) {
            addInputVariable("spring","Return spring rate","N/m",10000,&spring);
            addInputVariable("preload","Return spring preload","N",200,&preload);
        }
        if (mode==Mode::Cushioned) {
            addInputVariable("lengthA","Retract-end cushion length","m",.015,&cushionLength[0]);
            addInputVariable("lengthB","Extend-end cushion length","m",.015,&cushionLength[1]);
            addInputVariable("areaA","Retract-end minimum opening","m^2",2e-6,&cushionArea[0]);
            addInputVariable("areaB","Extend-end minimum opening","m^2",2e-6,&cushionArea[1]);
            addInputVariable("rho","Liquid density","kg/m^3",870,&density);
            addInputVariable("Cq","Cushion discharge coefficient","",.67,&coefficient);
        }
        addOutputVariable("travel","Accepted coordinate",rotary ? "rad" : "m",0,&positionOut);
        addOutputVariable("rate","Accepted speed",rotary ? "rad/s" : "m/s",0,&rateOut);
        addOutputVariable("effort","Hydraulic force or torque",rotary ? "N m" : "N",0,&effortOut);
    }
    void initialize() {
        for (int i=0; i<portCount; ++i) {
            pressure[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::Pressure);
            flow[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::Flow);
            wave[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::WaveVariable);
            impedance[i]=getSafeNodeDataPtr(ports[i],hopsan::NodeHydraulic::CharImpedance);
        }
        if (!(*limit>0 && *inertia>0 && *damping>=0 && *initialPosition>=0 && *initialPosition<=*limit) ||
            !std::isfinite(*initialRate) || !std::isfinite(*load) || !std::isfinite(*reference)) {
            stopSimulation("Invalid teaching actuator design or initial state"); return;
        }
        for (int i=0; i<portCount; ++i) {
            if (!(*sweep[i]>0) || (mode==Mode::Cushioned && !(*cushionLength[i]>=0 && *cushionArea[i]>0))) {
                stopSimulation("Invalid teaching actuator sweep or cushion"); return;
            }
        }
        if ((mode==Mode::Cushioned && !(*density>0 && *coefficient>0)) ||
            (mode==Mode::Spring && !(*spring>=0 && *preload>=0))) {
            stopSimulation("Invalid teaching actuator spring or fluid"); return;
        }
        position=*initialPosition;
        rate=*initialRate;
        publish(rate,cushionResistance(rate>=0));
    }
    void simulateOneTimestep() {
        const double stiffness=mode==Mode::Spring ? *spring : 0;
        double drive=*inertia*rate/mTimestep-*load-stiffness*position;
        if (mode==Mode::Spring) drive-=*preload;
        double linear=*inertia/mTimestep+*damping+stiffness*mTimestep;
        for (int i=0; i<portCount; ++i) {
            if (!std::isfinite(*wave[i]) || !std::isfinite(*impedance[i]) || *impedance[i]<0) {
                stopSimulation("Invalid teaching actuator TLM boundary"); return;
            }
            drive+=swept(i)*(*wave[i]-*reference);
            linear+=*impedance[i]*swept(i)*swept(i);
        }
        const double resistance=cushionResistance(drive>=0);
        const double freeRate=2*drive/(linear+std::sqrt(linear*linear+4*resistance*std::abs(drive)));
        if (!std::isfinite(freeRate)) { stopSimulation("Invalid teaching actuator speed"); return; }
        const double next=std::max(0.0,std::min(*limit,position+mTimestep*freeRate));
        const double sweptRate=(next-position)/mTimestep;
        // Inelastic unilateral contact. Keep the swept volume of the impact
        // step, then publish the stopped speed at the accepted position.
        rate=(next==0 && freeRate<0) || (next==*limit && freeRate>0) ? 0 : freeRate;
        position=next;
        publish(sweptRate,resistance);
    }
};
