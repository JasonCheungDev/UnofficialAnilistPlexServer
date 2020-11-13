// alert("Hello World!")

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