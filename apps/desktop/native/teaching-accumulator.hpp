// Single-port ideal polytropic gas accumulator. SI and absolute gas pressures.
// Hopsan owns time/network coupling; this component owns its liquid inventory.
#include "ComponentEssentials.h"
#include <cmath>
using namespace hopsan;

class HydraulicTeachingAccumulator : public ComponentQ {
    Port *port;
    double *p, *q, *c, *z;
    double *total, *precharge, *exponent, *minimumFraction, *resistance, *initialOil;
    double *oil, *gas, *gasPressure, *energy;
    double inventory=0;

    double pressureAt(double volume) const {
        return *precharge*std::pow(*total/(*total-volume),*exponent);
    }
    bool publish(double inflow) {
        const double terminal=*c-*z*inflow;
        if(!std::isfinite(terminal)||!std::isfinite(inflow)||terminal<=0) {
            stopSimulation("Accumulator outside positive absolute pressure domain"); return false;
        }
        *p=terminal; *q=-inflow;
        *oil=inventory; *gas=*total-inventory; *gasPressure=pressureAt(inventory);
        if(!std::isfinite(*gasPressure)||*gasPressure>20e6) {
            stopSimulation("Accumulator ideal gas pressure exceeds 20 MPa absolute teaching domain"); return false;
        }
        const double logRatio=std::log(*total/ *gas), delta=*exponent-1;
        // Compression work relative to the empty/precharged state, not gas internal energy.
        *energy=*precharge * *total*(delta==0?logRatio:std::expm1(delta*logRatio)/delta);
        return true;
    }
public:
    static Component *Creator() { return new HydraulicTeachingAccumulator(); }
    void configure() {
        port=addPowerPort("H","NodeHydraulic");
        addInputVariable("V0","Total gas volume when empty","m^3",.001,&total);
        addInputVariable("p0","Absolute nitrogen precharge","Pa",1.1e6,&precharge);
        addInputVariable("n","Fixed polytropic exponent","",1.4,&exponent);
        addInputVariable("minimumFraction","Minimum supported gas volume fraction","",.25,&minimumFraction);
        addInputVariable("R","Finite liquid inlet resistance","Pa s/m^3",1e10,&resistance);
        addInputVariable("initialOil","Explicit initial liquid inventory","m^3",0,&initialOil);
        addOutputVariable("Vo","Liquid inventory","m^3",0,&oil);
        addOutputVariable("Vg","Gas volume","m^3",.001,&gas);
        addOutputVariable("pg","Absolute gas pressure","Pa",1.1e6,&gasPressure);
        addOutputVariable("E","Gas compression work from empty state","J",0,&energy);
    }
    void initialize() {
        p=getSafeNodeDataPtr(port,NodeHydraulic::Pressure);
        q=getSafeNodeDataPtr(port,NodeHydraulic::Flow);
        c=getSafeNodeDataPtr(port,NodeHydraulic::WaveVariable);
        z=getSafeNodeDataPtr(port,NodeHydraulic::CharImpedance);
        if(!std::isfinite(*total)||!std::isfinite(*precharge)||!std::isfinite(*exponent)||
           !std::isfinite(*minimumFraction)||!std::isfinite(*resistance)||!std::isfinite(*initialOil)||
           *total<=0||*precharge<=0||*exponent<1||*exponent>1.4||*minimumFraction<=0||*minimumFraction>=1||
           *resistance<=0||*initialOil<0||*initialOil>*total*(1-*minimumFraction)) {
            stopSimulation("Invalid accumulator gas/initial inventory parameters"); return;
        }
        inventory=*initialOil;
        if(!std::isfinite(*c)||!std::isfinite(*z)||*z<0) { stopSimulation("Invalid accumulator boundary"); return; }
        double inflow=(*c-pressureAt(inventory))/(*resistance+*z);
        if(inventory==0 && inflow<0) inflow=0; // Empty bladder closes the liquid outlet.
        publish(inflow); // Initialization never integrates a hidden first timestep.
    }
    void simulateOneTimestep() {
        if(!std::isfinite(*c)||!std::isfinite(*z)||*z<0) { stopSimulation("Invalid accumulator boundary"); return; }
        // Backward Euler inventory balance: Vnew=Vold+h*qin.
        // Monotone scalar root couples gas law, inlet loss and the actual TLM boundary.
        const double maximum=*total*(1-*minimumFraction), previous=inventory;
        const auto residual=[&](double volume) {
            return (*resistance+*z)*(volume-previous)/mTimestep+pressureAt(volume)-*c;
        };
        if(residual(maximum)<0) {
            stopSimulation("Accumulator minimum gas volume exceeded; unsupported compression"); return;
        }
        if(residual(0)>=0) inventory=0; // Unilateral empty-bladder contact; no gas injection.
        else {
            double low=0, high=maximum;
            for(int i=0;i<80;i++) {
                const double middle=(low+high)/2;
                if(residual(middle)>0) high=middle; else low=middle;
            }
            inventory=(low+high)/2;
        }
        publish((inventory-previous)/mTimestep);
    }
};
