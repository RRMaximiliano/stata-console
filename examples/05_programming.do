********************************************************************************
* Test 5: Programming constructs
* Tests: foreach, forvalues, program, locals, macros, syntax highlighting
********************************************************************************

clear all
set more off

sysuse nlsw88, clear

* --- Foreach ---
local outcomes wage tenure hours

foreach y of local outcomes {
    quietly: reg `y' i.race age, robust
    di "`y': coef on race=2 is " %6.3f _b[2.race] " (p=" %5.3f 2*ttail(e(df_r), abs(_b[2.race]/_se[2.race])) ")"
}

* --- Forvalues ---
forvalues i = 1/5 {
    di "Iteration `i'"
}

* --- Program ---
capture program drop myreg
program define myreg
    syntax varlist(min=2) [if] [in], [robust]

    gettoken depvar indepvars : varlist

    di _n "Dependent variable: `depvar'"
    di "Independent variables: `indepvars'"

    if "`robust'" != "" {
        reg `depvar' `indepvars' `if' `in', robust
    }
    else {
        reg `depvar' `indepvars' `if' `in'
    }
end

myreg wage tenure hours age, robust

* --- Tempfile ---
tempfile tmp
save "`tmp'", replace
use "`tmp'", clear
di "Loaded from tempfile: " _N " obs"

* --- Timer ---
timer clear
timer on 1
quietly: reg wage tenure hours age i.race i.industry, robust
timer off 1
timer list 1
