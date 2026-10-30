********************************************************************************
* Outline Demo — Open the Outline panel (Cmd+Shift+O) to see the structure
********************************************************************************

* =========================================================================== *
* Setup
* =========================================================================== *

clear all
set more off

* --------------------------------------------------------------------------- *
* Load Data
* --------------------------------------------------------------------------- *

sysuse nlsw88, clear
gen treat = (race == 1)

* --------------------------------------------------------------------------- *
* Summary Statistics
* --------------------------------------------------------------------------- *

summarize wage tenure hours age
tabulate race

* --------------------------------------------------------------------------- *
* Regressions
* --------------------------------------------------------------------------- *

reg wage treat, robust
reg wage treat tenure hours, robust
reg wage treat tenure hours age i.race, robust
reghdfe wage treat tenure hours age, absorb(industry) 

* --------------------------------------------------------------------------- *
* Custom Programs
* --------------------------------------------------------------------------- *

capture program drop balance_test
program define balance_test
    syntax varlist, treat(varname)
    foreach v of varlist `varlist' {
        quietly: ttest `v', by(`treat')
        di "`v': diff = " %6.3f r(mu_1)-r(mu_2) "  p = " %5.3f r(p)
    }
end

balance_test tenure hours age, treat(treat)

capture program drop quick_reg
program quick_reg
    syntax varlist(min=2) [if], [robust]
    gettoken depvar indepvars : varlist
    di _n "=== `depvar' on `indepvars' ==="
    reg `depvar' `indepvars' `if', `robust'
end

quick_reg wage treat tenure, robust

* --------------------------------------------------------------------------- *
* Loops
* --------------------------------------------------------------------------- *

local outcomes wage tenure hours

foreach y of local outcomes {
    quietly: reg `y' treat age, robust
    di "`y': beta = " %6.3f _b[treat]
}

forvalues i = 1/3 {
    di "Specification `i'"
}

* --------------------------------------------------------------------------- *
* Graphics
* --------------------------------------------------------------------------- *

scatter wage tenure
histogram wage, normal
scatter wage hours 

* --------------------------------------------------------------------------- *
* Export Results
* --------------------------------------------------------------------------- *

di _n "Done."
