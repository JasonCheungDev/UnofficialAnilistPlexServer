// alert("Hello World!")

function onUpdateButtonClick() {
    console.log("Update button was clicked.")

    fetch('/update', {
        method: 'PUT'
    }).then(response => {
        if (response.ok) {
            console.log("Update response OK.")
        } else {
            console.error("Update resource FAILED")
        }
    }).catch(error => {
        console.error(error)
    })
}

function onGenericButtonClick(url) {
    console.log("Button was clicked")

    fetch(url, {
        method: 'PUT'
    }).then(response => {
        if (response.ok) {
            console.log("Response OK.")
            location.reload()
        } else {
            console.error("Response FAILED")
        }    
    }).catch(error => {
        console.error(erro)
    })
}