# Resetting the Cinder-7 Thermostat

This article applies to Cinder-7 thermostats with firmware version
4.2 or higher. If your thermostat displays the firmware on the boot
splash, confirm the version before proceeding.

## Symptom

The temperature display freezes on the home screen and does not
update when ambient temperature changes. The schedule LED blinks
amber every 12 seconds.

## Cause

The Cinder-7's onboard sensor calibration table can drift after a
sustained brown-out (line voltage below 96 V for more than 4
hours). Firmware 4.2 introduced an automatic recalibration routine,
but it only runs after a hard reset.

## Resolution

1. Press and hold the **MODE** button for 11 seconds. The display
   will dim, then show "RST" in the upper-right corner.
2. While "RST" is visible, press the **UP** arrow three times.
3. Wait 38 seconds without touching the unit. The thermostat will
   reboot and run a 90-second recalibration sweep.
4. After the sweep completes, the schedule LED returns to solid
   green and the temperature display refreshes every 5 seconds.

If the schedule LED remains amber after 90 seconds, the sensor
module itself has failed. Open a hardware-replacement ticket with
support and reference SKU **CDR7-SNS-A14**.

## Related articles

- HVAC-203 — Diagnosing brown-out conditions on shared electrical
  panels.
- CDR-44 — Reading firmware version on Cinder-series thermostats.
