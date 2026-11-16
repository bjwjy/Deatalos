// HydraulicWorkbench E35: internally piloted, internally drained two-stage
// quasi-static teaching valve. No pilot chamber compressibility or spool inertia.
// Main opening follows a force balance; the feed restriction and pilot stage
// carry a real, conserved pilot flow. This is not a vendor-calibrated DB model.
#include "ComponentEssentials.h"
#include <cmath>

class HydraulicTeachingPilotRelief : public hopsan::ComponentQ {
    hopsan::Port *p1, *p2;
    double *pressure1, *pressure2, *flow1, *flow2, *wave1, *wave2, *z1, *z2;
    double *setting, *feedArea, *pilotArea, *coefficient, *density;
    double *diameter, *stiffness, *preload, *maximumTravel;

    double flowAtDifferential(double dp) const {
        if (dp <= *setting) return 0;
        // q_feed = Cq*Af*sqrt(2*(dp-pc)/rho)
        // q_pilot = Cq*Ap*sqrt(2*(pc-setting)/rho)
        // Their unique steady intersection gives pc relative to drain T.
        const double af2 = *feedArea * *feedArea;
        const double ap2 = *pilotArea * *pilotArea;
        const double pc = (af2 * dp + ap2 * *setting) / (af2 + ap2);
        const double pilot = *coefficient * *feedArea * std::sqrt(2 * (dp-pc) / *density);
        const double forceArea = 3.141592653589793 * *diameter * *diameter / 4;
        const double lift = std::fmin(*maximumTravel,
            std::fmax(0.0, (forceArea * (dp-pc) - *preload) / *stiffness));
        const double mainArea = 3.141592653589793 * *diameter * lift;
        return pilot + *coefficient * mainArea * std::sqrt(2 * dp / *density);
    }
public:
    static hopsan::Component *Creator() { return new HydraulicTeachingPilotRelief(); }
    void configure() {
        p1 = addPowerPort("P1", "NodeHydraulic");
        p2 = addPowerPort("P2", "NodeHydraulic");
        addInputVariable("setting", "Pilot cracking differential relative to T", "Pa", 3e6, &setting);
        addInputVariable("feedArea", "Pilot feed restriction area", "m^2", 1e-7, &feedArea);
        addInputVariable("pilotArea", "Equivalent pilot relief opening", "m^2", 2e-7, &pilotArea);
        addInputVariable("Cq", "Discharge coefficient", "", .67, &coefficient);
        addInputVariable("rho", "Oil density", "kg/m^3", 870, &density);
        addInputVariable("diameter", "Main spool diameter", "m", .01, &diameter);
        addInputVariable("stiffness", "Main spring stiffness", "N/m", 20000, &stiffness);
        addInputVariable("preload", "Main spring preload force", "N", 2, &preload);
        addInputVariable("maximumTravel", "Maximum main spool lift", "m", .0003, &maximumTravel);
    }
    void initialize() {
        pressure1 = getSafeNodeDataPtr(p1, hopsan::NodeHydraulic::Pressure);
        pressure2 = getSafeNodeDataPtr(p2, hopsan::NodeHydraulic::Pressure);
        flow1 = getSafeNodeDataPtr(p1, hopsan::NodeHydraulic::Flow);
        flow2 = getSafeNodeDataPtr(p2, hopsan::NodeHydraulic::Flow);
        wave1 = getSafeNodeDataPtr(p1, hopsan::NodeHydraulic::WaveVariable);
        wave2 = getSafeNodeDataPtr(p2, hopsan::NodeHydraulic::WaveVariable);
        z1 = getSafeNodeDataPtr(p1, hopsan::NodeHydraulic::CharImpedance);
        z2 = getSafeNodeDataPtr(p2, hopsan::NodeHydraulic::CharImpedance);
        if (!(*setting > 0 && *feedArea > 0 && *pilotArea > 0 && *density > 0
              && *coefficient > 0 && *diameter > 0 && *stiffness > 0
              && *preload >= 0 && *maximumTravel > 0)) {
            stopSimulation("Invalid pilot relief parameters"); return;
        }
        simulateOneTimestep();
    }
    void simulateOneTimestep() {
        const double dc = *wave1 - *wave2;
        const double impedance = *z1 + *z2;
        double low = 0, high = std::fmax(0.0, dc);
        // Local constitutive root only. Hopsan retains ownership of the network.
        for (int i=0; i<60; ++i) {
            const double dp = (low + high) / 2;
            if (dp + impedance * flowAtDifferential(dp) > dc) high = dp;
            else low = dp;
        }
        const double q = flowAtDifferential((low + high) / 2);
        const double a = *wave1 - *z1*q, b = *wave2 + *z2*q;
        if (!std::isfinite(q) || !std::isfinite(a) || !std::isfinite(b) || a < -1e-5 || b < -1e-5) {
            stopSimulation("Pilot relief outside non-cavitating domain"); return;
        }
        *flow1 = -q; *flow2 = q; *pressure1 = a; *pressure2 = b;
    }
};
