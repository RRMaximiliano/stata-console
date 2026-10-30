********************************************************************************
* Test 6: Interactive console commands
* Run these ONE LINE AT A TIME using Cmd+Enter to test interactive mode
********************************************************************************

* Load data
sysuse auto, clear

* Type these in the console after running the line above:
*
* 1. Test interactive typing:
*    reg price mpg weight
*
* 2. Test browse interception:
*    browse
*    browse price mpg if foreign
*    br in 1/10
*
* 3. Test edit interception:
*    edit
*
* 4. Test command history (up/down arrows)
*
* 5. Test clear console (Cmd+L)
*
* 6. Test Ctrl+C interrupt
*
* 7. Check sidebar panels update:
*    - Data panel shows: auto.dta, 74 obs, 12 vars
*    - Variables panel shows all variables
*    - After running reg: Stored Results shows e() values
