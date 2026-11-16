#pragma once
#include "ComponentEssentials.h"
#include <algorithm>
#include <array>
#include <cmath>

// Quasistatic three-port valves. Port flows below are positive into the valve.
class HydraulicTeachingPressureLogic : public hopsan::ComponentQ {
    const bool pilotClose;
    std::array<hopsan::Port*,3> ports{};
    std::array<double*,3> p{}, q{}, c{}, z{};
    double *area, *coefficient, *density, *setting, *band;

    static double orifice(double drive, double impedance, double gain) {
        if (drive <= 0) return 0;
        const double loss=gain*impedance;
        return 2*gain*drive/(loss+std::sqrt(loss*loss+4*drive));
    }
    std::array<double,3> closeCheck(double gain) const {
        // The closing pilot piston is referenced to A. Its opposing force
        // increases monotonically as inlet pressure falls under load.
        const double ca=*c[0], cb=*c[1], cx=*c[2];
        const double impedance=*z[0]+*z[1];
        const double drive=ca-cb-*setting;
        double flow=orifice(drive,impedance,gain);
        if (cx>ca-*z[0]*flow)
            flow=orifice(drive-*band*(cx-ca),impedance+*band* *z[0],gain);
        return {flow,-flow,0};
    }
    std::array<double,3> reduceOrRelieve(double gain) const {
        const double signal=*c[1]-*c[2]-*setting;
        if (signal==0) return {0,0,0};
        const bool supplying=signal<0;
        const int from=supplying ? 0 : 1, to=supplying ? 1 : 2;
        const double drive=*c[from]-*c[to], impedance=*z[from]+*z[to];
        const double feedback=supplying ? *z[1] : impedance;
        double low=0, high=orifice(drive,impedance,gain);
        for (int i=0; i<52 && high>low; ++i) {
            const double trial=(low+high)/2;
            const double opening=std::max(0.0,std::min(1.0,(std::abs(signal)-feedback*trial)/ *band));
            const double law=gain*opening*std::sqrt(std::max(0.0,drive-impedance*trial));
            if (trial>law) high=trial;
            else low=trial;
        }
        const double flow=(low+high)/2;
        std::array<double,3> result{};
        result[from]=flow; result[to]=-flow;
        return result;
    }
public:
    explicit HydraulicTeachingPressureLogic(bool close) : pilotClose(close) {}
    static hopsan::Component *PilotClose() { return new HydraulicTeachingPressureLogic(true); }
    static hopsan::Component *ReducingRelieving() { return new HydraulicTeachingPressureLogic(false); }
    void configure() {
        ports[0]=addPowerPort(pilotClose ? "A" : "P","NodeHydraulic");
        ports[1]=addPowerPort(pilotClose ? "B" : "A","NodeHydraulic");
        ports[2]=addPowerPort(pilotClose ? "X" : "T","NodeHydraulic");
        addInputVariable("area","Maximum seat opening","m^2",1e-5,&area);
        addInputVariable("Cq","Discharge coefficient","",.67,&coefficient);
        addInputVariable("rho","Oil density","kg/m^3",870,&density);
        if (pilotClose) {
            addInputVariable("crack","Unpiloted cracking differential","Pa",0,&setting);
            addInputVariable("ratio","Closing pilot area ratio","",3,&band);
        } else {
            addInputVariable("setting","Regulated outlet pressure relative to tank","Pa",3e6,&setting);
            addInputVariable("band","Pressure increment for full opening","Pa",5e5,&band);
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
        if (!(*area>0 && *coefficient>0 && *density>0 && *setting>=0 && *band>0)) {
            stopSimulation("Invalid pressure logic valve parameters"); return;
        }
        for (int i=0; i<3; ++i) {
            if (!std::isfinite(*c[i]) || !std::isfinite(*z[i]) || *z[i]<0) {
                stopSimulation("Invalid pressure logic valve TLM boundary"); return;
            }
        }
        const double gain=*coefficient * *area * std::sqrt(2 / *density);
        const auto flow=pilotClose ? closeCheck(gain) : reduceOrRelieve(gain);
        std::array<double,3> pressure{};
        for (int i=0; i<3; ++i) {
            pressure[i]=*c[i]-*z[i]*flow[i];
            if (!std::isfinite(flow[i]) || !std::isfinite(pressure[i]) || pressure[i]< -1e-5) {
                stopSimulation("Pressure logic valve outside non-cavitating domain"); return;
            }
        }
        for (int i=0; i<3; ++i) {
            *p[i]=pressure[i];
            *q[i]=-flow[i];
        }
    }
};
