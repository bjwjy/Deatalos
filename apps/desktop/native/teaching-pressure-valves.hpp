// E1.2S08: finite quasistatic pressure-control constitutive models.
// Only local TLM equations are solved here; Hopsan owns network/time coupling.
#include "ComponentEssentials.h"
#include <array>
#include <algorithm>
#include <cmath>
using namespace hopsan;
class HydraulicTeachingPressureValve : public ComponentQ {
    const int kind; // 0 reducer, 1 sequence, 2 externally drained pilot check, 3 internally drained pilot check.
    std::array<Port*,4> ports{};
    std::array<double*,4> p{}, q{}, c{}, z{};
    double *area, *coefficient, *density, *setting=nullptr, *band=nullptr;
    double *reverseArea=nullptr, *crack, *ratio=nullptr;
    static double through(double dc, double impedance, double a, double cq, double rho, double bias) {
        const double excess=dc-bias;
        if(excess<=0 || a==0) return 0;
        const double resistance=rho/(2*cq*cq*a*a);
        return 2*excess/(impedance+std::sqrt(impedance*impedance+4*resistance*excess));
    }
public:
    explicit HydraulicTeachingPressureValve(int k) : kind(k) {}
    static Component *Reducer() { return new HydraulicTeachingPressureValve(0); }
    static Component *Sequence() { return new HydraulicTeachingPressureValve(1); }
    static Component *PilotCheck() { return new HydraulicTeachingPressureValve(2); }
    static Component *PilotCheckInternal() { return new HydraulicTeachingPressureValve(3); }
    void configure() {
        const char *main0=kind>=2?"A":"P", *main1=kind>=2?"B":"A";
        ports[0]=addPowerPort(main0,"NodeHydraulic");
        ports[1]=addPowerPort(main1,"NodeHydraulic");
        if(kind>=2) ports[2]=addPowerPort("X","NodeHydraulic");
        if(kind!=3) ports[kind==2?3:2]=addPowerPort("Y","NodeHydraulic");
        addInputVariable("area","Finite main opening","m^2",1e-5,&area);
        addInputVariable("Cq","Discharge coefficient","",.67,&coefficient);
        addInputVariable("rho","Density","kg/m^3",870,&density);
        addInputVariable("crack","Forward check or reverse bypass cracking differential","Pa",1e5,&crack);
        if(kind>=2) addInputVariable("ratio","Pilot area to seat area ratio","",3,&ratio);
        else {
            addInputVariable("setting","Control pressure relative to Y","Pa",3e6,&setting);
            addInputVariable("band","Finite pressure modulation band","Pa",5e5,&band);
            addInputVariable("reverseArea","Optional reverse bypass; zero disables","m^2",0,&reverseArea);
        }
    }
    void initialize() {
        for(int i=0;i<(kind==2?4:3);i++) {
            p[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::Pressure);
            q[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::Flow);
            c[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::WaveVariable);
            z[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::CharImpedance);
        }
        simulateOneTimestep();
    }
    void simulateOneTimestep() {
        if(!std::isfinite(*area) || !std::isfinite(*coefficient) || !std::isfinite(*density) ||
           !std::isfinite(*crack) || *area<=0 || *coefficient<=0 || *density<=0 || *crack<0 ||
           (kind>=2 && (!std::isfinite(*ratio) || *ratio<=0)) ||
           (kind<2 && (!std::isfinite(*setting) || !std::isfinite(*band) || !std::isfinite(*reverseArea) ||
                       *setting<=0 || *band<=0 || *reverseArea<0))) {
            stopSimulation("Invalid pressure control parameters"); return;
        }
        for(int i=0;i<(kind==2?4:3);i++) if(!std::isfinite(*c[i]) || !std::isfinite(*z[i]) || *z[i]<0) {
            stopSimulation("Invalid pressure control TLM boundary"); return;
        }
        const double dc=*c[0]-*c[1], impedance=*z[0]+*z[1];
        const double py=*c[kind==3?0:kind==2?3:2]; // Evaluate the blocked active set; internal drain references A.
        double flow=0;
        if(kind>=2) {
            if(dc>0) flow=through(dc,impedance,*area,*coefficient,*density,*crack);
            else if(dc<0) {
                // Evaluate the blocked active set (q=0 => pB=cB). Open only when it cannot remain seated.
                // External drain references Y; the common three-port structure references actual main return A.
                const double unseat=*ratio*(*c[2]-py)-(*c[1]-py)-*crack;
                if(unseat>0) {
                    double opened=through(-dc,impedance,*area,*coefficient,*density,0);
                    // A check is not a counterbalance/modulating valve. Reject a flowing branch that cannot
                    // retain enough pilot force; do not return an invented partially throttled equilibrium.
                    const double opposing=(kind==3?(*ratio-1)* *z[0]-*z[1]:0);
                    if(opposing>0 && unseat<opposing*opened) {
                        stopSimulation("Pilot check cannot sustain full opening; motion-control regime unsupported"); return;
                    }
                    flow=-opened;
                }
            }
        } else if(dc>0) {
            double low=0, high=through(dc,impedance,*area,*coefficient,*density,0);
            // q-F(q) is monotone: actual pA rises for the reducer and actual pP falls for the sequence valve.
            for(int i=0;i<80;i++) {
                const double trial=(low+high)/2;
                const double pp=*c[0]-*z[0]*trial, pa=*c[1]+*z[1]*trial;
                const double signal=kind==0 ? (*setting-(pa-py)) : ((pp-py)-*setting);
                const double fraction=std::max(0.0,std::min(1.0,signal / *band));
                const double law=*coefficient * *area*fraction*std::sqrt(2*std::max(0.0,pp-pa) / *density);
                if(trial>law) high=trial; else low=trial;
            }
            flow=(low+high)/2;
        } else if(dc<0) flow=-through(-dc,impedance,*reverseArea,*coefficient,*density,*crack);
        const double pa=*c[0]-*z[0]*flow, pb=*c[1]+*z[1]*flow;
        if(!std::isfinite(flow) || !std::isfinite(pa) || !std::isfinite(pb) || pa< -1e-5 || pb< -1e-5) {
            stopSimulation("Pressure control outside non-cavitating domain"); return;
        }
        for(int i=2;i<(kind==2?4:3);i++) {
            if(*c[i]< -1e-5) { stopSimulation("Pilot or drain outside non-cavitating domain"); return; }
            *p[i]=*c[i]; *q[i]=0;
        }
        *p[0]=pa; *p[1]=pb; *q[0]=-flow; *q[1]=flow;
    }
};
