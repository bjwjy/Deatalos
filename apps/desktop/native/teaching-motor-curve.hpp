#pragma once

#include "ComponentEssentials.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <string>

// Read-only port taps feed the stock motor's displacement signal each native step.
class HydraulicTeachingMotorCurve : public hopsan::ComponentSignal {
    using Cubic = std::array<double, 4>;
    struct Segment { Cubic pressure, displacement; };
    std::array<Segment, 25> segments{};
    int count = 0;
    hopsan::Port *a = nullptr, *b = nullptr;
    double *pA = nullptr, *pB = nullptr, *dp = nullptr, *displacement = nullptr;
    double *voltage = nullptr, *sample = nullptr;
    int external = 0;
    double lowPressure = 1e6, highPressure = 5e6;

    static double cubic(const Cubic &values, double t) {
        const double u = 1 - t;
        return u*u*u*values[0] + 3*u*u*t*values[1] + 3*u*t*t*values[2] + t*t*t*values[3];
    }
    bool validSegments() const {
        if (count < 1 || count > static_cast<int>(segments.size()) || segments[0].pressure[0] < 0)
            return false;
        for (int i = 0; i < count; ++i) {
            const Segment &segment = segments[i];
            if (segment.pressure[3] > 70e6 ||
                (i > 0 && (segments[i-1].pressure[3] != segment.pressure[0] ||
                           segments[i-1].displacement[3] != segment.displacement[0])))
                return false;
            for (size_t j = 0; j < 4; ++j) {
                if (!std::isfinite(segment.pressure[j]) || !std::isfinite(segment.displacement[j]) ||
                    segment.displacement[j] <= 0 || segment.displacement[j] > 0.01 ||
                    (j > 0 && segment.pressure[j-1] >= segment.pressure[j]))
                    return false;
            }
        }
        return true;
    }

public:
    static hopsan::Component *Creator() { return new HydraulicTeachingMotorCurve(); }

    void configure() override {
        a = addReadPort("A", "NodeHydraulic", "Motor port A pressure", hopsan::Port::NotRequired);
        b = addReadPort("B", "NodeHydraulic", "Motor port B pressure", hopsan::Port::NotRequired);
        addInputVariable("U", "External control voltage", "V", 0, &voltage);
        addOutputVariable("sample", "External voltage used for displacement", "V", 0, &sample);
        addOutputVariable("D", "Displacement per revolution", "m3/rev", 0, &displacement);
        addOutputVariable("dp", "Pressure magnitude used for displacement", "Pa", 0, &dp);
        addConstant("segmentCount", "Number of active curve segments", "", 0, count);
        addConstant("external", "Use external pressure reconstructed from voltage", "", 0, external);
        addConstant("lowPressure", "Pressure at zero volts", "Pa", 1e6, lowPressure);
        addConstant("highPressure", "Pressure at ten volts", "Pa", 5e6, highPressure);
        for (size_t i = 0; i < segments.size(); ++i) {
            for (size_t j = 0; j < 4; ++j) {
                const std::string key = std::to_string(i) + "_" + std::to_string(j);
                addConstant(("p" + key).c_str(), "Bezier pressure", "Pa", 0.0, segments[i].pressure[j]);
                addConstant(("d" + key).c_str(), "Bezier displacement", "m3/rev", 0.0, segments[i].displacement[j]);
            }
        }
    }
    void initialize() override {
        if (!validSegments() || (external && !(highPressure > lowPressure))) {
            stopSimulation("Invalid motor displacement curve coefficients");
            return;
        }
        if (!external) {
            pA = getSafeNodeDataPtr(a, hopsan::NodeHydraulic::Pressure);
            pB = getSafeNodeDataPtr(b, hopsan::NodeHydraulic::Pressure);
        }
        simulateOneTimestep();
    }
    void simulateOneTimestep() override {
        if (external && (!std::isfinite(*voltage) || *voltage < 0 || *voltage > 10)) {
            stopSimulation("Invalid voltage for motor pressure curve");
            return;
        }
        const double pressure = external
            ? (*voltage == 10 ? highPressure : lowPressure + (highPressure-lowPressure)*(*voltage/10))
            : std::abs(*pA - *pB);
        *sample = external ? *voltage : 0;
        if (!std::isfinite(pressure)) {
            stopSimulation("Non-finite motor curve pressure");
            return;
        }
        *dp = pressure;
        const auto end = segments.begin() + count;
        const auto segment = std::lower_bound(segments.begin(), end, pressure,
            [](const Segment &s, double p) { return s.pressure[3] < p; });
        if (segment == end) {
            *displacement = segments[count-1].displacement[3];
            return;
        }
        if (pressure <= segment->pressure[0]) {
            *displacement = segment->displacement[0];
            return;
        }
        if (pressure == segment->pressure[3]) {
            *displacement = segment->displacement[3];
            return;
        }
        // Pressure control coordinates are strictly increasing, so this root is unique.
        double low = 0, high = 1;
        for (int i = 0; i < 32; ++i) {
            const double mid = (low + high) / 2;
            if (cubic(segment->pressure, mid) < pressure) low = mid;
            else high = mid;
        }
        const auto bounds = std::minmax_element(segment->displacement.begin(), segment->displacement.end());
        *displacement = std::max(*bounds.first, std::min(*bounds.second, cubic(segment->displacement, (low + high) / 2)));
    }
};
