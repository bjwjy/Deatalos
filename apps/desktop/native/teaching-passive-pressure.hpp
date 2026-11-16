#pragma once
#include "ComponentEssentials.h"
#include <algorithm>
#include <array>
#include <cmath>

// Port order follows each model's design definition. Positive native flow
// leaves the component. The local laws never use an undeclared supply.
class HydraulicTeachingPassivePressure : public hopsan::ComponentQ {
    enum class Kind { Flow, Shock, Intensifier };
    const Kind kind;
    std::array<hopsan::Port*,3> ports{};
    std::array<double*,3> pressure{}, flow{}, wave{}, impedance{};
    double *rho=nullptr, *coefficient=nullptr, *area=nullptr, *reference;
    double *rated=nullptr, *compensation=nullptr, *band=nullptr;
    double *reliefA=nullptr, *reliefB=nullptr, *makeupArea=nullptr, *crack=nullptr;
    std::array<double*,2> reliefFlow{}, makeupFlow{};
    double *ratio=nullptr, *boostResistance=nullptr, *bypassResistance=nullptr;

    double orifice(double head, double z, double opening) const {
        if (head<=0 || opening<=0) return 0;
        const double resistance=.5 * *rho/std::pow(*coefficient*opening,2);
        return 2*head/(z+std::sqrt(z*z+4*resistance*head));
    }
    template<class Residual>
    static double bisect(double low, double high, const Residual &residual) {
        for (int i=0; i<48; ++i) {
            const double mid=(low+high)/2;
            if (residual(mid)<0) low=mid;
            else high=mid;
        }
        return (low+high)/2;
    }
    std::array<double,3> priorityFlows() const {
        const double meterArea=*rated/(*coefficient*std::sqrt(2* *compensation/ *rho));
        const auto outlets=[&](double inlet) {
            const double working=orifice(inlet-*wave[1],*impedance[1],meterArea);
            const double drop=inlet-(*wave[1]+*impedance[1]*working);
            const double fraction=std::max(0.0,std::min(1.0,(drop-*compensation)/ *band));
            const double bypass=orifice(inlet-*wave[2],*impedance[2],*area*fraction);
            return std::array<double,2>{{working,bypass}};
        };
        const double supply=*wave[0], z=*impedance[0];
        const double inlet=z==0 || supply<=0 ? supply : bisect(0,supply,[&](double p) {
            const auto q=outlets(p);
            return p+z*(q[0]+q[1])-supply;
        });
        const auto q=outlets(inlet);
        return {{-q[0]-q[1],q[0],q[1]}};
    }
    std::array<double,3> shockFlows() const {
        const auto toTank=[&](int i, double tank) {
            const double dp=*wave[i]-tank;
            return orifice(dp-(i==0 ? *reliefA : *reliefB),*impedance[i],*area)-
                orifice(-dp-*crack,*impedance[i],*makeupArea);
        };
        const double cT=*wave[2], zT=*impedance[2];
        const double tank=zT==0 ? cT : bisect(
            std::min({*wave[0],*wave[1],cT}),std::max({*wave[0],*wave[1],cT}),
            [&](double p) { return p-cT-zT*(toTank(0,p)+toTank(1,p)); });
        const double a=toTank(0,tank), b=toTank(1,tank);
        return {{-a,-b,a+b}};
    }
    std::array<double,3> intensifiedFlows() const {
        const double r=*ratio, returned=r-1;
        const double zi=*impedance[0], zh=*impedance[1], zr=*impedance[2];
        const double head=r*(*wave[0]-*wave[2])-(*wave[1]-*wave[2]);
        const double fillHead=*wave[0]-*wave[1]-*crack;
        const double boostLoss=*boostResistance+r*r*zi+zh+returned*returned*zr;
        const double fillLoss=*bypassResistance+zi+zh;
        const double cross=r*zi+zh;
        const auto fill=[&](double boost) { return std::max(0.0,(fillHead-cross*boost)/fillLoss); };
        const double upper=std::max(0.0,head/boostLoss);
        // Shared-port coupling makes opening the fill path reduce the boost head.
        const double boost=upper==0 || fill(upper)==0 ? upper :
            cross*fill(0)>=head ? 0 : bisect(0,upper,[&](double q) {
                return boostLoss*q+cross*fill(q)-head;
            });
        const double bypass=fill(boost);
        return {{-r*boost-bypass,boost+bypass,returned*boost}};
    }
public:
    explicit HydraulicTeachingPassivePressure(Kind model) : kind(model) {}
    static hopsan::Component *PriorityFlow() { return new HydraulicTeachingPassivePressure(Kind::Flow); }
    static hopsan::Component *ShockMakeup() { return new HydraulicTeachingPassivePressure(Kind::Shock); }
    static hopsan::Component *Intensifier() { return new HydraulicTeachingPassivePressure(Kind::Intensifier); }
    void configure() {
        ports[0]=addPowerPort(kind==Kind::Flow ? "P" : kind==Kind::Shock ? "A" : "IN","NodeHydraulic");
        ports[1]=addPowerPort(kind==Kind::Flow ? "A" : kind==Kind::Shock ? "B" : "H","NodeHydraulic");
        ports[2]=addPowerPort(kind==Kind::Intensifier ? "R" : "T","NodeHydraulic");
        addInputVariable("reference","Engineering pressure reference","Pa",0,&reference);
        if (kind==Kind::Intensifier) {
            addInputVariable("ratio","Pressure multiplication ratio","",3,&ratio);
            addInputVariable("boostR","Equivalent booster flow resistance","Pa s/m^3",1e11,&boostResistance);
            addInputVariable("bypassR","Fill bypass resistance","Pa s/m^3",1e10,&bypassResistance);
            addInputVariable("crack","Fill bypass cracking pressure","Pa",1e4,&crack);
            return;
        }
        addInputVariable("rho","Oil density","kg/m^3",870,&rho);
        addInputVariable("Cq","Discharge coefficient","",.67,&coefficient);
        addInputVariable("area","Maximum bypass or relief area","m^2",1e-5,&area);
        if (kind==Kind::Flow) {
            addInputVariable("rated","Nominal priority flow","m^3/s",1.0/60000,&rated);
            addInputVariable("setting","Metering pressure differential","Pa",5e5,&compensation);
            addInputVariable("band","Bypass opening band","Pa",5e4,&band);
        } else {
            addInputVariable("reliefA","A-to-T relief setting","Pa",3e6,&reliefA);
            addInputVariable("reliefB","B-to-T relief setting","Pa",3e6,&reliefB);
            addInputVariable("makeupArea","Makeup check area per port","m^2",1e-5,&makeupArea);
            addInputVariable("crack","Makeup cracking pressure","Pa",1e4,&crack);
            addOutputVariable("reliefAFlow","A to T relief flow","m^3/s",0,&reliefFlow[0]);
            addOutputVariable("reliefBFlow","B to T relief flow","m^3/s",0,&reliefFlow[1]);
            addOutputVariable("makeupAFlow","T to A makeup flow","m^3/s",0,&makeupFlow[0]);
            addOutputVariable("makeupBFlow","T to B makeup flow","m^3/s",0,&makeupFlow[1]);
        }
    }
    void initialize() {
        if (kind==Kind::Shock) {
            const std::array<double,7> parameters{{*rho,*coefficient,*area,*reliefA,*reliefB,*makeupArea,*crack}};
            if (!std::all_of(parameters.begin(),parameters.end(),[](double v) { return std::isfinite(v) && v>=0; }) ||
                *rho==0 || *coefficient==0) {
                stopSimulation("Invalid shock relief and makeup parameters");
                return;
            }
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
        for (size_t i=0; i<ports.size(); ++i) {
            if (!std::isfinite(*wave[i]) || !std::isfinite(*impedance[i]) || *impedance[i]<0) {
                stopSimulation("Invalid passive pressure component boundary");
                return;
            }
        }
        const auto flows=kind==Kind::Flow ? priorityFlows() : kind==Kind::Shock ? shockFlows() : intensifiedFlows();
        std::array<double,3> p{};
        for (size_t i=0; i<ports.size(); ++i) {
            p[i]=*wave[i]+*impedance[i]*flows[i];
            if (!std::isfinite(p[i]) || !std::isfinite(flows[i]) || p[i]<-1e-5 || p[i]-*reference>70e6+1e-5) {
                stopSimulation("Passive pressure component outside supported pressure domain");
                return;
            }
        }
        for (size_t i=0; i<ports.size(); ++i) {
            *pressure[i]=p[i];
            *flow[i]=flows[i];
        }
        if (kind==Kind::Shock) {
            // Nonnegative cracking pressures make the two paths mutually exclusive at each work port.
            for (size_t i=0; i<reliefFlow.size(); ++i) {
                *reliefFlow[i]=std::max(0.0,-flows[i]);
                *makeupFlow[i]=std::max(0.0,flows[i]);
            }
        }
    }
};
