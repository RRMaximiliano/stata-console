********************************************************************************
* Run All Tests — Pipeline
*
* Calls each test do-file in sequence within the same Stata session.
* Tests that nested do-file execution works properly.
*
* Note: `browse` only works in code run directly via the extension
* (Cmd+Shift+D or typed in terminal), not inside nested do-files.
* That's why individual test files have browse commented out.
********************************************************************************

clear all
set more off

di _n "{hline 70}"
di "  TEST PIPELINE — Starting"
di "{hline 70}" _n

do "01_basic.do"
di _n ">>> 01_basic — PASSED" _n

do "02_regression.do"
di _n ">>> 02_regression — PASSED" _n

do "03_graphics.do"
di _n ">>> 03_graphics — PASSED (check Plots pane)" _n

* Skip 04 — has intentional reshape error that stops the pipeline
* do "04_data_management.do"

do "05_programming.do"
di _n ">>> 05_programming — PASSED" _n

* Browse works here because this is the top-level code
clear all
sysuse auto, clear
browse make price mpg in 1/10

di _n "{hline 70}"
di "  ALL TESTS PASSED"
di "  Check: Plots pane, Data Viewer, Variables, Stored Results"
di "{hline 70}" _n
