// HydraulicWorkbench teaching model, version 0.2.0.
// A local two-port constitutive component; Hopsan owns network coupling/time.
// No topology, templates or application state are inspected here.
#include "ComponentEssentials.h"
#include <cmath>
#include "teaching-pilot-relief.hpp"
#include "teaching-directional.hpp"
#include "teaching-manifold.hpp"
#include "teaching-pressure-valves.hpp"
#include "teaching-load-valves.hpp"
#include "teaching-accumulator.hpp"
#include "teaching-shuttle.hpp"
#include "teaching-pressure-logic.hpp"
#include "teaching-actuator.hpp"
#include "teaching-oil-storage.hpp"
#include "teaching-motor-cavity.hpp"
#include "teaching-cylinder-cavity.hpp"
#include "teaching-divider-instrument.hpp"
#include "teaching-passive-pressure.hpp"
#include "teaching-motor-curve.hpp"
#include "teaching-hysteretic-pressure.hpp"
using namespace hopsan;

class HydraulicTeachingRestriction : public ComponentQ {
    Port *p1, *p2;
    double *pressure1, *pressure2, *flow1, *flow2, *wave1, *wave2, *z1, *z2;
    double *forwardArea, *reverseArea, *baseArea, *forwardCrack, *reverseCrack, *coefficient, *density;
public:
    static Component *Creator() { return new HydraulicTeachingRestriction(); }
    void configure() {
        p1 = addPowerPort("P1", "NodeHydraulic");
        p2 = addPowerPort("P2", "NodeHydraulic");
        addInputVariable("Aforward", "Forward opening area", "m^2", 1e-5, &forwardArea);
        addInputVariable("Areverse", "Reverse opening area", "m^2", 0, &reverseArea);
        addInputVariable("Abase", "Parallel bidirectional metering area", "m^2", 0, &baseArea);
        addInputVariable("pForward", "Forward cracking differential", "Pa", 1e5, &forwardCrack);
        addInputVariable("pReverse", "Reverse cracking differential", "Pa", 0, &reverseCrack);
        addInputVariable("Cq", "Discharge coefficient", "", .67, &coefficient);
        addInputVariable("rho", "Oil density", "kg/m^3", 870, &density);
    }
    void initialize() {
        pressure1 = getSafeNodeDataPtr(p1, NodeHydraulic::Pressure);
        pressure2 = getSafeNodeDataPtr(p2, NodeHydraulic::Pressure);
        flow1 = getSafeNodeDataPtr(p1, NodeHydraulic::Flow);
        flow2 = getSafeNodeDataPtr(p2, NodeHydraulic::Flow);
        wave1 = getSafeNodeDataPtr(p1, NodeHydraulic::WaveVariable);
        wave2 = getSafeNodeDataPtr(p2, NodeHydraulic::WaveVariable);
        z1 = getSafeNodeDataPtr(p1, NodeHydraulic::CharImpedance);
        z2 = getSafeNodeDataPtr(p2, NodeHydraulic::CharImpedance);
        simulateOneTimestep();
    }
    void simulateOneTimestep() {
        const double dc = *wave1 - *wave2, impedance = *z1 + *z2;
        const bool forward = dc >= 0;
        const double area = forward ? *forwardArea : *reverseArea;
        const double excess = std::abs(dc) - (forward ? *forwardCrack : *reverseCrack);
        double q = 0;
        if (*baseArea > 0) {
            // Parallel meter and check share the same ACTUAL pressure difference.
            // This scalar constitutive root is local to one two-port component.
            const double crack = forward ? *forwardCrack : *reverseCrack;
            const auto curve = [&](double dp) {
                return *coefficient * std::sqrt(2 / *density) *
                    (*baseArea * std::sqrt(dp) + area * std::sqrt(std::fmax(0.0, dp - crack)));
            };
            double low = 0, high = std::abs(dc);
            for (int i=0; i<60; ++i) {
                const double middle = (low + high) / 2;
                if (middle + impedance * curve(middle) > std::abs(dc)) high = middle;
                else low = middle;
            }
            q = curve((low + high) / 2);
            if (!forward) q = -q;
        } else if (area > 0 && excess > 0) {
            const double resistance = *density / (2 * std::pow(*coefficient * area, 2));
            // Stable positive root of R*q^2 + (Z1+Z2)*q = |c1-c2|-pcrack.
            q = 2 * excess / (impedance + std::sqrt(impedance * impedance + 4 * resistance * excess));
            if (!forward) q = -q;
        }
        const double a = *wave1 - *z1 * q, b = *wave2 + *z2 * q;
        if (!std::isfinite(q) || !std::isfinite(a) || !std::isfinite(b) || a < -1e-5 || b < -1e-5) {
            stopSimulation("Teaching restriction outside non-cavitating domain"); return;
        }
        *flow1 = -q; *flow2 = q; *pressure1 = a; *pressure2 = b;
    }
};
extern "C" DLLEXPORT void register_contents(ComponentFactory *factory, NodeFactory *nodes) {
    factory->registerCreatorFunction("HydraulicTeachingMotorCurve", HydraulicTeachingMotorCurve::Creator);
    factory->registerCreatorFunction("HydraulicTeachingPriorityFlow", HydraulicTeachingPassivePressure::PriorityFlow);
    factory->registerCreatorFunction("HydraulicTeachingShockMakeup", HydraulicTeachingPassivePressure::ShockMakeup);
    factory->registerCreatorFunction("HydraulicTeachingIntensifier", HydraulicTeachingPassivePressure::Intensifier);
    factory->registerCreatorFunction("HydraulicTeachingDifferentialGauge", HydraulicTeachingDifferentialGauge::Creator);
    factory->registerCreatorFunction("HydraulicTeachingDividerCombiner", HydraulicTeachingDividerCombiner::Creator);
    factory->registerCreatorFunction("HydraulicTeachingSynchronizingDivider", HydraulicTeachingDividerCombiner::Synchronizing);
    factory->registerCreatorFunction("HydraulicTeachingPressureSwitch", HydraulicTeachingHystereticPressure::Switch);
    factory->registerCreatorFunction("HydraulicTeachingVoltageDisplacement", HydraulicTeachingVoltageDisplacement::Creator);
    factory->registerCreatorFunction("HydraulicTeachingUnloadValve", HydraulicTeachingHystereticPressure::UnloadValve);
    factory->registerCreatorFunction("HydraulicTeachingOilStorage", HydraulicTeachingOilStorage::Creator);
    factory->registerCreatorFunction("HydraulicTeachingMotorVolume", HydraulicTeachingMotorVolume::Creator);
    factory->registerCreatorFunction("HydraulicTeachingCavityMotor", HydraulicTeachingCavityMotor::Creator);
    factory->registerCreatorFunction("HydraulicTeachingCavityCylinder", HydraulicTeachingCavityCylinder::Creator);
    factory->registerCreatorFunction("HydraulicTeachingShuttle", HydraulicTeachingShuttle::Creator);
    factory->registerCreatorFunction("HydraulicTeachingSpringCylinder", HydraulicTeachingActuator::SpringCylinder);
    factory->registerCreatorFunction("HydraulicTeachingCushionedCylinder", HydraulicTeachingActuator::CushionedCylinder);
    factory->registerCreatorFunction("HydraulicTeachingLimitedRotary", HydraulicTeachingActuator::Rotary);
    factory->registerCreatorFunction("HydraulicTeachingTwoPressure", HydraulicTeachingShuttle::TwoPressure);
    factory->registerCreatorFunction("HydraulicTeachingPilotClose", HydraulicTeachingPressureLogic::PilotClose);
    factory->registerCreatorFunction("HydraulicTeachingReducingRelieving", HydraulicTeachingPressureLogic::ReducingRelieving);
    factory->registerCreatorFunction("HydraulicTeachingAccumulator", HydraulicTeachingAccumulator::Creator);
    factory->registerCreatorFunction("HydraulicTeachingCounterbalance", HydraulicTeachingLoadValve::Counterbalance);
    factory->registerCreatorFunction("HydraulicTeachingCompensatedFlow", HydraulicTeachingLoadValve::CompensatedFlow);
    factory->registerCreatorFunction("HydraulicTeachingReducer", HydraulicTeachingPressureValve::Reducer);
    factory->registerCreatorFunction("HydraulicTeachingSequence", HydraulicTeachingPressureValve::Sequence);
    factory->registerCreatorFunction("HydraulicTeachingPilotCheck", HydraulicTeachingPressureValve::PilotCheck);
    factory->registerCreatorFunction("HydraulicTeachingPilotCheckInternal", HydraulicTeachingPressureValve::PilotCheckInternal);
    factory->registerCreatorFunction("HydraulicTeachingDirectional2", HydraulicTeachingDirectional::Creator2);
    factory->registerCreatorFunction("HydraulicTeachingDirectional3", HydraulicTeachingDirectional::Creator3);
    factory->registerCreatorFunction("HydraulicTeachingDirectional4", HydraulicTeachingDirectional::Creator4);
    factory->registerCreatorFunction("HydraulicTeachingDirectional5", HydraulicTeachingDirectional::Creator5);
    factory->registerCreatorFunction("HydraulicTeachingManifold2", HydraulicTeachingManifold::Creator2);
    factory->registerCreatorFunction("HydraulicTeachingManifold3", HydraulicTeachingManifold::Creator3);
    factory->registerCreatorFunction("HydraulicTeachingManifold4", HydraulicTeachingManifold::Creator4);
    factory->registerCreatorFunction("HydraulicTeachingPilotSeries4", HydraulicTeachingManifold::CreatorPilotSeries);
    factory->registerCreatorFunction("HydraulicTeachingManifold5", HydraulicTeachingManifold::Creator5);
    factory->registerCreatorFunction("HydraulicTeachingPilotRelief", HydraulicTeachingPilotRelief::Creator);
    factory->registerCreatorFunction("HydraulicTeachingRestriction", HydraulicTeachingRestriction::Creator);
    HOPSAN_UNUSED(nodes)
}
extern "C" DLLEXPORT void get_hopsan_info(HopsanExternalLibInfoT *info) {
    info->libName = (char*)"HydraulicWorkbenchTeaching020";
    info->hopsanCoreVersion = (char*)HOPSANCOREVERSION;
    info->libCompiledDebugRelease = (char*)HOPSAN_BUILD_TYPE_STR;
}
