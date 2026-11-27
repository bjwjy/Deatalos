// Model 0.5.0: prescribed finite connectivity with a zero-storage internal
// junction for each connected group. Hopsan still owns network/time coupling.
// A two-port group uses area A directly. A larger group has sqrt(2)*A at each
// branch so two branches in series have the same declared equivalent area A.
#include "ComponentEssentials.h"
#include <array>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
using namespace hopsan;
class HydraulicTeachingManifold : public ComponentQ {
    const int count;
    const int numChecks;
    const char *names[6] = {"P", "A", "T", "B", "Load", "Pilot"};
    std::array<Port*,6> ports{};
    std::array<double*,6> p{}, q{}, c{}, z{};
    double *command, *travel, *area, *coefficient, *density, *positive, *neutral, *negative, *position;
    struct Check {
        double *area, *coefficient, *cracking, *ratio;
        double pressure;
    };
    std::array<Check,2> checks{};
    double *pilotSide, *junctionInitial;
    static double through(double dc, double impedance, double resistance) {
        if (dc == 0) return 0;
        const double magnitude = 2*std::abs(dc)/(impedance+std::sqrt(impedance*impedance+4*resistance*std::abs(dc)));
        return dc < 0 ? -magnitude : magnitude;
    }
    static constexpr int firstLoad=4, singlePilot=5;

    // Positive transfer, work -> load. A cross pilot pushing the poppet off
    // its seat can carry the spring preload as flow changes direction.
    // dp_check = Rcheck*q^2 + max(0, crack - ratio*max(0, pilot-pJ)).
    static double assistedForward(double work, double load, double zw, double zl,
                                  double rv, double rc, double pilot, double ratio,
                                  double crack, double passive) {
        const double head=work-load, z=zw+zl, r=rv+rc;
        const double junction=work-zw*passive-rv*passive*passive;
        if(pilot<=junction) return passive;
        const double full=through(head,z,r);
        if(ratio*(pilot-junction)>=crack) return full;

        // From the passive flow, find the first accessible equilibrium. A
        // convex residual can dip below zero before the full-open endpoint.
        const double a=ratio*rv-r, b=ratio*zw-z;
        const double c=head-crack+ratio*(pilot-work);
        if(passive==0 && c<=0) return 0;
        const auto residual=[&](double q) { return (a*q+b)*q+c; };
        double low=passive, high=full;
        if(a>0) high=std::max(low,std::min(full,-b/(2*a)));
        if(residual(high)>=0) return full;
        for(int i=0;i<52;i++) {
            const double q=(low+high)*.5;
            if(residual(q)>0) low=q; else high=q;
        }
        return (low+high)*.5;
    }

    // The ideal junction has one pressure and no storage. The forward path
    // has two series orifices plus cracking pressure. Reverse poppet lift is
    // bounded by its seat/full-open stops and the internal-drain force balance.
    void solvePilotSeries(int side, int work, int loadPort, Check &check, double pilot,
                          double resistance, std::array<double,6> &flow, bool crossPilot=false) {
        const double load=*c[loadPort], ratio=*check.ratio, crack=*check.cracking;
        double &junctionPressure=check.pressure;
        if(work<0) {
            // With the spool path closed, keep the last pressure if it permits
            // zero flow. Otherwise project it onto the seated pressure interval.
            junctionPressure=std::min(junctionPressure,load+crack);
            if(crossPilot && junctionPressure>load && pilot>junctionPressure &&
               ratio*(pilot-junctionPressure)+(junctionPressure-load)>crack) {
                // The zero-volume closed spool stub equilibrates through the lifted poppet.
                junctionPressure=load;
            } else if(junctionPressure<load && ratio*(pilot-junctionPressure)>load-junctionPressure+crack) {
                junctionPressure=ratio==1 ? load : std::min(load,(ratio*pilot-load-crack)/(ratio-1));
            }
            return;
        }
        const double workWave=*c[work], workImpedance=*z[work], loadImpedance=*z[loadPort];
        const double checkResistance=*density/(2*std::pow(*check.coefficient * *check.area,2));
        const double seriesResistance=resistance+checkResistance, impedance=workImpedance+loadImpedance;
        double transfer=0;
        if(workWave>load) {
            if(workWave-load>crack)
                transfer=through(workWave-load-crack,impedance,seriesResistance);
            if(crossPilot)
                transfer=assistedForward(workWave,load,workImpedance,loadImpedance,resistance,
                                         checkResistance,pilot,ratio,crack,transfer);
        } else if(workWave<load) {
            const double seatedForce=ratio*(pilot-workWave)-(load-workWave)-crack;
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
    explicit HydraulicTeachingManifold(int n, int checksInSeries=0) : count(n), numChecks(checksInSeries) {}
    static Component *Creator2() { return new HydraulicTeachingManifold(2); }
    static Component *Creator3() { return new HydraulicTeachingManifold(3); }
    static Component *Creator4() { return new HydraulicTeachingManifold(4); }
    static Component *Creator5() { return new HydraulicTeachingManifold(5); }
    static Component *CreatorPilotSeries() { return new HydraulicTeachingManifold(4,1); }
    static Component *CreatorPilotLockPair() { return new HydraulicTeachingManifold(4,2); }
    void configure() {
        const int portCount=numChecks?6:count;
        for (int i=0;i<portCount;i++) {
            const bool readback=numChecks && (i==1 || i==3);
            const char *name=!numChecks && i==4 ? "R" : names[i];
            if(numChecks==2 && i>=firstLoad) name=i==firstLoad?"LoadA":"LoadB";
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
        if(numChecks==1)
            addInputVariable("pilotSide","Internal work port index (A=1, B=3)","",3,&pilotSide);
        if(numChecks)
            addInputVariable("junctionInitial","Initial pressure of blocked ideal junction","Pa",1e5,&junctionInitial);
        for(int i=0;i<numChecks;i++) {
            auto &check=checks[i];
            addInputVariable(i?"checkAreaB":"checkArea","Full pilot check opening","m^2",1e-5,&check.area);
            addInputVariable(i?"checkCqB":"checkCq","Pilot check discharge coefficient","",.67,&check.coefficient);
            addInputVariable(i?"checkCrackB":"checkCrack","Pilot check cracking differential","Pa",1e5,&check.cracking);
            addInputVariable(i?"pilotRatioB":"pilotRatio","Pilot to seat area ratio","",3,&check.ratio);
        }
    }
    void initialize() {
        for (int i=0;i<(numChecks?6:count);i++) {
            p[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::Pressure);
            q[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::Flow);
            c[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::WaveVariable);
            z[i]=getSafeNodeDataPtr(ports[i],NodeHydraulic::CharImpedance);
        }
        for(int i=0;i<numChecks;i++) checks[i].pressure=*junctionInitial;
        simulateOneTimestep();
    }
    void simulateOneTimestep() {
        if (!std::isfinite(*command) || !std::isfinite(*travel) || !std::isfinite(*area) ||
            !std::isfinite(*coefficient) || !std::isfinite(*density) || *travel<=0 || *area<=0 || *coefficient<=0 || *density<=0) {
            stopSimulation("Invalid manifold valve input"); return;
        }
        std::array<int,2> sides{{1,3}}, work{{-1,-1}};
        if(numChecks==1) {
            if((*pilotSide!=1 && *pilotSide!=3) || !ports[4-static_cast<int>(*pilotSide)]->isConnected()) {
                stopSimulation("Invalid pilot series port connection"); return;
            }
            sides[0]=static_cast<int>(*pilotSide);
        }
        std::array<int,6> checkIndex{{-1,-1,-1,-1,-1,-1}};
        for(int k=0;k<numChecks;k++) {
            const auto &check=checks[k];
            if(ports[sides[k]]->isConnected() || !std::isfinite(*check.area) || *check.area<=0 ||
               !std::isfinite(*check.coefficient) || *check.coefficient<=0 || !std::isfinite(*check.cracking) ||
               *check.cracking<0 || !std::isfinite(*check.ratio) || *check.ratio<1 || !std::isfinite(check.pressure)) {
                stopSimulation("Invalid pilot series valve parameters or connection"); return;
            }
            checkIndex[sides[k]]=k;
        }
        const int portCount=numChecks?6:count;
        for(int i=0;i<portCount;i++) if(checkIndex[i]<0 && (!std::isfinite(*c[i]) || !std::isfinite(*z[i]) || *z[i]<0)) {
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
            int branch=-1;
            for(int k=0;k<numChecks;k++) if(group[sides[k]]==root) branch=k;
            if(branch>=0) {
                if(n>2) {stopSimulation("Pilot series requires a two-port spool path");return;}
                const int peer=n==2 ? (members[0]==sides[branch]?members[1]:members[0]) : -1;
                if(peer>=0 && checkIndex[peer]>=0) {stopSimulation("Cross-connected lock work ports");return;}
                work[branch]=peer;
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
        if(numChecks==1)
            solvePilotSeries(sides[0],work[0],firstLoad,checks[0],*c[singlePilot],resistance,flow);
        if(numChecks==2) {
            // First evaluate both seated/free-forward branches. A reverse-flowing
            // poppet requires its opposite junction to be higher than its own.
            // Only the lower branch sees a positive pilot differential. Reverse
            // transfer cannot raise it above the pilot; forward assist lowers it.
            // In either direction the other branch stays on its passive solution.
            for(int k=0;k<2;k++) {
                const double seated=work[k]>=0 ? *c[work[k]] :
                    std::min(checks[k].pressure,*c[firstLoad+k]+*checks[k].cracking);
                solvePilotSeries(sides[k],work[k],firstLoad+k,checks[k],seated,resistance,flow);
            }
            const int lower=checks[0].pressure<=checks[1].pressure ? 0 : 1;
            solvePilotSeries(sides[lower],work[lower],firstLoad+lower,checks[lower],
                             checks[1-lower].pressure,resistance,flow,true);
        }
        std::array<double,6> pressures{};
        for(int i=0;i<portCount;i++) {
            const double pressure=checkIndex[i]>=0 ? checks[checkIndex[i]].pressure : *c[i]+*z[i]*flow[i];
            pressures[i]=pressure;
            if(!std::isfinite(flow[i]) || !std::isfinite(pressure) || pressure < -1e-5) {
                if(numChecks==2) {
                    char message[160];
                    std::snprintf(message,sizeof(message),"Pilot lock pair %s outside non-cavitating domain: %.9g Pa",
                                  ports[i]->getName().c_str(),pressure);
                    stopSimulation(message);
                } else stopSimulation("Manifold valve outside non-cavitating domain");
                return;
            }
        }
        for(int i=0;i<portCount;i++) {*q[i]=flow[i];*p[i]=pressures[i];}
        *position=*command;
    }
};
