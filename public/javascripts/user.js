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