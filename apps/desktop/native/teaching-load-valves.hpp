// E1.2S09: finite quasistatic local laws. Hopsan owns network and time coupling.
#include "ComponentEssentials.h"
#include <array>
#include <algorithm>
#include <cmath>
using namespace hopsan;
class HydraulicTeachingLoadValve : public ComponentQ {
    const bool counter;
    std::array<Port*,3> ports{};
    std::array<double*,3> p{}, q{}, c{}, z{};
    double *area, *coefficient, *density, *setting=nullptr, *band=nullptr, *ratio=nullptr, *crack=nullptr, *compensation=nullptr;
    static double orifice(double dc, double impedance, double a, double cq, double rho, double bias=0) {
        if(dc<=bias || a==0) return 0;
        const double resistance=rho/(2*cq*cq*a*a);
        return 2*(dc-bias)/(impedance+std::sqrt(impedance*impedance+4*resistance*(dc-bias)));
    }
public:
    explicit HydraulicTeachingLoadValve(bool loadControl): counter(loadControl) {}
    static Component *Counterbalance() { return new HydraulicTeachingLoadValve(true); }
    static Component *CompensatedFlow() { return new HydraulicTeachingLoadValve(false); }
    void configure() {
        ports[0]=addPowerPort(counter?"A":"P", "NodeHydraulic");
        ports[1]=addPowerPort(counter?"B":"A", "NodeHydraulic");
        addInputVariable("area","Finite metering opening","m^2",counter?1e-5:2e-6,&area);
        addInputVariable("Cq","Discharge coefficient","",.67,&coefficient);
        addInputVariable("rho","Density","kg/m^3",870,&density);
        if(counter) {
            ports[2]=addPowerPort("X","NodeHydraulic");
            addInputVariable("setting","Non-vented load pressure setting","Pa",4e6,&setting);
            addInputVariable("band","Pressure modulation band","Pa",5e5,&band);
            addInputVariable("ratio","Pilot ratio","",3,&ratio);
            addInputVariable("crack","Free A to B cracking differential","Pa",1e5,&crack);
        } else addInputVariable("compensation","Compensated metering differential","Pa",5e5,&compensation);
    }
    void initialize() {
        for(int i=0;i<(counter?3:2);i++) {
            p[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::Pressure);
            q[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::Flow);
            c[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::WaveVariable);
            z[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::CharImpedance);
        }
        simulateOneTimestep();
    }
    void simulateOneTimestep() {
        if(!std::isfinite(*area)||!std::isfinite(*coefficient)||!std::isfinite(*density)||*area<0||*coefficient<=0||*density<=0||
           (counter&&(!std::isfinite(*setting)||!std::isfinite(*band)||!std::isfinite(*ratio)||!std::isfinite(*crack)||*setting<=0||*band<=0||*ratio<=0||*crack<0))||
           (!counter&&(!std::isfinite(*compensation)||*compensation<=0))) { stopSimulation("Invalid load/flow control parameters"); return; }
        for(int i=0;i<(counter?3:2);i++) if(!std::isfinite(*c[i])||!std::isfinite(*z[i])||*z[i]<0) { stopSimulation("Invalid load/flow control boundary"); return; }
        const double dc=*c[0]-*c[1], impedance=*z[0]+*z[1];
        double flow=0;
        if(!counter) {
            const double available=orifice(std::abs(dc),impedance,*area,*coefficient,*density);
            const double target=*coefficient * *area*std::sqrt(2* *compensation/ *density);
            flow=dc>=0?std::min(available,target):-available;
        } else if(dc>0) flow=orifice(dc,impedance,*area,*coefficient,*density,*crack);
        else if(dc<0) {
            double low=0, high=orifice(-dc,impedance,*area,*coefficient,*density);
            // B->A: pB falls and pA rises with flow, so the pilot-weighted force decreases monotonically.
            for(int i=0;i<80;i++) {
                const double trial=(low+high)/2, pa=*c[0]+*z[0]*trial, pb=*c[1]-*z[1]*trial;
                const double signal=(pb-pa)+*ratio*(*c[2]-pa)-*setting;
                const double fraction=std::max(0.0,std::min(1.0,signal/ *band));
                const double law=*coefficient * *area*fraction*std::sqrt(2*std::max(0.0,pb-pa)/ *density);
                if(trial>law) high=trial; else low=trial;
            }
            flow=-(low+high)/2;
        }
        const double first=*c[0]-*z[0]*flow, second=*c[1]+*z[1]*flow;
        if(!std::isfinite(flow)||!std::isfinite(first)||!std::isfinite(second)||first< -1e-5||second< -1e-5||
           (counter&&*c[2]< -1e-5)) { stopSimulation("Load/flow control outside non-cavitating domain"); return; }
        *p[0]=first; *p[1]=second; *q[0]=-flow; *q[1]=flow;
        if(counter) { *p[2]=*c[2]; *q[2]=0; }
    }
};
