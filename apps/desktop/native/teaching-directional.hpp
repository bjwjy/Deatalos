// Finite, quasistatic directional valve model 0.4.0. Each permitted working
// position is a matching of disjoint two-port orifices. No network solver here.
#include "ComponentEssentials.h"
#include <array>
#include <cmath>
using namespace hopsan;
class HydraulicTeachingDirectional : public ComponentQ {
    const int count;
    const char *names[5] = {"P", "A", "T", "B", "R"};
    std::array<Port*,5> ports{};
    std::array<double*,5> p{}, q{}, c{}, z{};
    double *command, *travel, *area, *coefficient, *density, *positive, *neutral, *negative, *position;
public:
    explicit HydraulicTeachingDirectional(int n) : count(n) {}
    static Component *Creator2() { return new HydraulicTeachingDirectional(2); }
    static Component *Creator3() { return new HydraulicTeachingDirectional(3); }
    static Component *Creator4() { return new HydraulicTeachingDirectional(4); }
    static Component *Creator5() { return new HydraulicTeachingDirectional(5); }
    void configure() {
        for (int i=0;i<count;i++) ports[i]=addPowerPort(names[i],"NodeHydraulic");
        addInputVariable("in","Prescribed quasistatic spool position","m",0,&command);
        addInputVariable("travel","Commanded end position","m",.0003,&travel);
        addInputVariable("area","Open area of each active path","m^2",1e-5,&area);
        addInputVariable("Cq","Discharge coefficient","",.67,&coefficient);
        addInputVariable("rho","Oil density","kg/m^3",870,&density);
        addInputVariable("positive","Positive position path mask","",0,&positive);
        addInputVariable("neutral","Middle position path mask","",0,&neutral);
        addInputVariable("negative","Negative position path mask","",0,&negative);
        addOutputVariable("xv","Prescribed quasistatic position; no spool inertia","m",0,&position);
    }
    void initialize() {
        for (int i=0;i<count;i++) {
            p[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::Pressure);
            q[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::Flow);
            c[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::WaveVariable);
            z[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::CharImpedance);
        }
        simulateOneTimestep();
    }
    void simulateOneTimestep() {
        if (!std::isfinite(*command) || *travel<=0 || *area<=0 || *coefficient<=0 || *density<=0) {
            stopSimulation("Invalid directional valve input"); return;
        }
        const double raw= *command > .5*(*travel) ? *positive : *command < -.5*(*travel) ? *negative : *neutral;
        if (!std::isfinite(raw) || raw<0 || raw>1023 || std::floor(raw)!=raw) {
            stopSimulation("Invalid directional valve mask"); return;
        }
        const int mask=static_cast<int>(raw);
        std::array<bool,5> used{};
        std::array<double,5> flow{};
        int bit=0;
        for (int a=0;a<5;a++) for(int b=a+1;b<5;b++,bit++) if (mask & (1<<bit)) {
            if (a>=count || b>=count || used[a] || used[b]) {
                stopSimulation("Unsupported nonmatching directional paths"); return;
            }
            used[a]=used[b]=true;
            const double dc=*c[a]-*c[b], impedance=*z[a]+*z[b];
            const double resistance=*density/(2*std::pow(*coefficient * *area,2));
            double through= dc==0 ? 0 : 2*std::abs(dc)/(impedance+std::sqrt(impedance*impedance+4*resistance*std::abs(dc)));
            if (dc<0) through=-through;
            flow[a]=-through; flow[b]=through;
        }
        for(int i=0;i<count;i++) {
            const double pressure=*c[i]+*z[i]*flow[i];
            if (!std::isfinite(flow[i]) || !std::isfinite(pressure) || pressure < -1e-5) {
                stopSimulation("Directional valve outside non-cavitating domain"); return;
            }
        }
        for(int i=0;i<count;i++) { *q[i]=flow[i]; *p[i]=*c[i]+*z[i]*flow[i]; }
        *position=*command;
    }
};
