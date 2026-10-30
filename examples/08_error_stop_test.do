********************************************************************************
* Test 8: Error-stop behavior
*
* Run this entire file. ONLY the first 3 lines should execute.
* Line 4 should error, and lines 5+ should NOT execute.
* If you see "THIS SHOULD NOT APPEAR", error-stop is broken.
********************************************************************************

clear all
set more off
sysuse auto, clear

* This line WILL error:
this_command_does_not_exist

* Everything below should NOT execute:
di "THIS SHOULD NOT APPEAR — LINE 1"
di "THIS SHOULD NOT APPEAR — LINE 2"
summarize price
browse
