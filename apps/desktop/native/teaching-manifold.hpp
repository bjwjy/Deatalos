// Model 0.5.0: prescribed finite connectivity with a zero-storage internal
// junction for each connected group. Hopsan still owns network/time coupling.
// A two-port group uses area A directly. A larger group has sqrt(2)*A at each
// branch so two branches in series have the same declared equivalent area A.
#include "ComponentEssentials.h"
#include <array>
#include <algorithm>
#include <cmath>
#include <limits>
using namespace hopsan;
class HydraulicTeachingManifold : public ComponentQ {
    const int count;
    const bool pilotSeries;
    const char *names[6] = {"P", "A", "T", "B", "Load", "Pilot"};
    std::array<Port*,6> ports{};
    std::array<double*,6> p{}, q{}, c{}, z{};
    double *command, *travel, *area, *coefficient, *density, *positive, *neutral, *negative, *position;
    double *pilotSide, *checkArea, *checkCoefficient, *cracking, *pilotRatio, *junctionInitial;
    double junctionPressure=0;
    static double through(double dc, double impedance, double resistance) {
        if (dc == 0) return 0;
        const double magnitude = 2*std::abs(dc)/(impedance+std::sqrt(impedance*impedance+4*resistance*std::abs(dc)));
        return dc < 0 ? -magnitude : magnitude;
    }
    static constexpr int loadPort=4, pilotPort=5;

    // The ideal junction has one pressure and no storage. The forward path
    // has two series orifices plus cracking pressure. Reverse poppet lift is
    // bounded by its seat/full-open stops and the internal-drain force balance.
    void solvePilotSeries(int side, int work, double resistance, std::array<double,6> &flow) {
        const double load=*c[loadPort], pilot=*c[pilotPort], ratio=*pilotRatio;
        if(work<0) {
            // With the spool path closed, keep the last pressure if it permits
            // zero flow. Otherwise project it onto the seated pressure interval.
            junctionPressure=std::min(junctionPressure,load+*cracking);
            if(junctionPressure<load && ratio*(pilot-junctionPressure)>load-junctionPressure+*cracking) {
                junctionPressure=ratio==1 ? load : std::min(load,(ratio*pilot-load-*cracking)/(ratio-1));
            }
            return;
        }
        const double workWave=*c[work], workImpedance=*z[work], loadImpedance=*z[loadPort];
        const double checkResistance=*density/(2*std::pow(*checkCoefficient * *checkArea,2));
        const double seriesResistance=resistance+checkResistance, impedance=workImpedance+loadImpedance;
        double transfer=0;
        if(workWave-load>*cracking) {
            transfer=through(workWave-load-*cracking,impedance,seriesResistance);
        } else if(workWave<load) {
            const double seatedForce=ratio*(pilot-workWave)-(load-workWave)-*cracking;
            if(seatedForce>0) {
                const double full=through(load-workWave,impedance,seriesResistance);
                const double linear=loadImpedance-(ratio-1)*workImpedance;
                const double quadratic=(ratio-1)*resistance;
                double reverse=full;
                if(seatedForce+full*(linear-quadratic*full)<0) {
                    // Force is positive at zero flow and negative at full lift.
                    // The positive root gives the flow at an intermediate lift.
                    double low=0, high=full;
                    for(int i=0;i<52;i++) {
                        const double trial=(low+high)*.5;
                        if(seatedForce+trial*(linear-quadratic*trial)>0) low=trial;
                        else high=trial;
                    }
                    reverse=(low+high)*.5;
                }
                transfer=-reverse;
            }
        }
        junctionPressure=workWave-workImpedance*transfer-resistance*transfer*std::abs(transfer);
        flow[work]=-transfer;
        flow[side]=transfer;
        flow[loadPort]=transfer;
    }
public:
    explicit HydraulicTeachingManifold(int n, bool series=false) : count(n), pilotSeries(series) {}
    static Component *Creator2() { return new HydraulicTeachingManifold(2); }
    static Component *Creator3() { return new HydraulicTeachingManifold(3); }
    static Component *Creator4() { return new HydraulicTeachingManifold(4); }
    static Component *Creator5() { return new HydraulicTeachingManifold(5); }
    static Component *CreatorPilotSeries() { return new HydraulicTeachingManifold(4,true); }
    void configure() {
        const int portCount=pilotSeries?6:count;
        for (int i=0;i<portCount;i++) {
            // A/B includes one unconnected readback for the internal junction.
            const bool readback=pilotSeries && (i==1 || i==3);
            const char *name=!pilotSeries && i==4 ? "R" : names[i];
            ports[i]=addPowerPort(name,"NodeHydraulic","",readback?Port::NotRequired:Port::Required);
        }
        addInputVariable("in","Prescribed quasistatic spool position","m",0,&command);
        addInputVariable("travel","Commanded end position","m",.0003,&travel);
        addInputVariable("area","Equivalent two-port opening area","m^2",1e-5,&area);
        addInputVariable("Cq","Discharge coefficient","",.67,&coefficient);
        addInputVariable("rho","Oil density","kg/m^3",870,&density);
        addInputVariable("positive","Positive connectivity mask","",0,&positive);
        addInputVariable("neutral","Middle connectivity mask","",0,&neutral);
        addInputVariable("negative","Negative connectivity mask","",0,&negative);
        addOutputVariable("xv","Prescribed position; no spool inertia","m",0,&position);
        if(pilotSeries) {
            addInputVariable("pilotSide","Internal work port index (A=1, B=3)","",3,&pilotSide);
            addInputVariable("checkArea","Full pilot check opening","m^2",1e-5,&checkArea);
            addInputVariable("checkCq","Pilot check discharge coefficient","",.67,&checkCoefficient);
            addInputVariable("checkCrack","Pilot check cracking differential","Pa",1e5,&cracking);
            addInputVariable("pilotRatio","Pilot to seat area ratio","",3,&pilotRatio);
            addInputVariable("junctionInitial","Initial pressure of blocked ideal junction","Pa",1e5,&junctionInitial);
        }
    }
    void initialize() {
        for (int i=0;i<(pilotSeries?6:count);i++) {
            p[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::Pressure);
            q[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::Flow);
            c[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::WaveVariable);
            z[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::CharImpedance);
        }
        if(pilotSeries) junctionPressure=*junctionInitial;
        simulateOneTimestep();
    }
    void simulateOneTimestep() {
        if (!std::isfinite(*command) || !std::isfinite(*travel) || !std::isfinite(*area) ||
            !std::isfinite(*coefficient) || !std::isfinite(*density) || *travel<=0 || *area<=0 || *coefficient<=0 || *density<=0) {
            stopSimulation("Invalid manifold valve input"); return;
        }
        int side=-1;
        if(pilotSeries) {
            if((*pilotSide!=1 && *pilotSide!=3) || !std::isfinite(*checkArea) || *checkArea<=0 ||
               !std::isfinite(*checkCoefficient) || *checkCoefficient<=0 ||
               !std::isfinite(*cracking) || *cracking<0 || !std::isfinite(*pilotRatio) || *pilotRatio<1) {
                stopSimulation("Invalid pilot series valve parameters"); return;
            }
            side=static_cast<int>(*pilotSide);
            if(ports[side]->isConnected() || !ports[4-side]->isConnected()) {
                stopSimulation("Invalid pilot series port connection"); return;
            }
        }
        const int portCount=pilotSeries?6:count;
        for(int i=0;i<portCount;i++) if(i!=side && (!std::isfinite(*c[i]) || !std::isfinite(*z[i]) || *z[i]<0)) {
            stopSimulation("Invalid manifold TLM boundary"); return;
        }
        const double raw= *command > .5*(*travel) ? *positive : *command < -.5*(*travel) ? *negative : *neutral;
        if (!std::isfinite(raw) || raw<0 || raw>1023 || std::floor(raw)!=raw) {
            stopSimulation("Invalid manifold connectivity mask"); return;
        }
        const int mask=static_cast<int>(raw);
        std::array<int,5> group{{0,1,2,3,4}};
        int bit=0;
        for(int a=0;a<5;a++) for(int b=a+1;b<5;b++,bit++) if(mask & (1<<bit)) {
            if(a>=count || b>=count) {stopSimulation("Manifold path outside available ports");return;}
            const int from=group[b], to=group[a];
            for(int i=0;i<count;i++) if(group[i]==from) group[i]=to;
        }
        std::array<double,6> flow{};
        const double resistance=*density/(2*std::pow(*coefficient * *area,2));
        for(int root=0;root<count;root++) {
            std::array<int,5> members{};
            int n=0;
            for(int i=0;i<count;i++) if(group[i]==root) members[n++]=i;
            if(side>=0 && group[side]==root) {
                if(n>2) {stopSimulation("Pilot series requires a two-port spool path");return;}
                const int work=n==2 ? (members[0]==side?members[1]:members[0]) : -1;
                solvePilotSeries(side,work,resistance,flow);
                continue;
            }
            if(n<2) continue;
            if(n==2) {
                const int a=members[0],b=members[1];
                const double value=through(*c[a]-*c[b],*z[a]+*z[b],resistance);
                flow[a]=-value; flow[b]=value;
                continue;
            }
            double low=std::numeric_limits<double>::infinity(), high=-low;
            for(int k=0;k<n;k++) {low=std::min(low,*c[members[k]]);high=std::max(high,*c[members[k]]);}
            double bestResidual=std::numeric_limits<double>::infinity(), bestPressure=low;
            // Scalar local mass balance is strictly monotone. Bisection brackets
            // only this valve's internal pressure, never the application network.
            for(int iteration=0;iteration<100;iteration++) {
                const double middle=low+(high-low)*.5;
                double sum=0;
                for(int k=0;k<n;k++) {const int i=members[k];sum+=through(middle-*c[i],*z[i],resistance*.5);}
                if(std::abs(sum)<bestResidual) {bestResidual=std::abs(sum);bestPressure=middle;}
                if(sum>0) high=middle; else low=middle;
            }
            double sum=0, magnitude=0;
            for(int k=0;k<n;k++) {
                const int i=members[k];
                flow[i]=through(bestPressure-*c[i],*z[i],resistance*.5);
                sum+=flow[i];magnitude+=std::abs(flow[i]);
            }
            if(!std::isfinite(sum) || std::abs(sum)>1e-12+1e-9*magnitude) {
                stopSimulation("Manifold internal mass balance did not converge");return;
            }
        }
        for(int i=0;i<portCount;i++) {
            const double pressure=i==side ? junctionPressure : *c[i]+*z[i]*flow[i];
            if(!std::isfinite(flow[i]) || !std::isfinite(pressure) || pressure < -1e-5) {
                stopSimulation("Manifold valve outside non-cavitating domain");return;
            }
        }
        for(int i=0;i<portCount;i++) {*q[i]=flow[i];*p[i]=i==side ? junctionPressure : *c[i]+*z[i]*flow[i];}
        *position=*command;
    }
};
