// RESOLUTION

window.addEventListener("load", () => {
    console.log("Page loaded")
    const resolutionTable = document.getElementById("resolution-table")
    if (resolutionTable) {
        console.log("Resolution mode enabled!")
        const resolutionFilterInput = document.getElementById("resolution-filter-input")
        const resolutionFilterCount = document.getElementById("resolution-filter-count")
        let resolutionFilter = "" 
    
        resolutionFilterInput.addEventListener("input", (event) => {
            resolutionFilter = event.target.value
            
            let count = 0
 
            // starting at row 5 as the first few rows are for headers/filtering
            for (let i = 4; i < resolutionTable.rows.length; i++) {
                const row = resolutionTable.rows[i]
                if (resolutionFilter == "") {
                    row.classList.remove("resolution-entry-disabled")
                    row.classList.remove("highlight-text")
                    continue
                }

                const title = row.cells[0].innerHTML
                if (!title.includes(resolutionFilter)) {
                    row.classList.add("resolution-entry-disabled")
                    row.classList.remove("highlight-text")
                } else {
                    row.classList.remove("resolution-entry-disabled")
                    row.classList.add("highlight-text")
                    count++
                }
            }

            resolutionFilterCount.innerHTML = count
        })
    } else {
        console.log("Resolution not required")
    }
})
