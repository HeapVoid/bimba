function colorize(text, fg, bg) {
    let result = ''
    if(fg) result += "\x1b[38;5;" + fg.toString() + "m"
    if(bg) result += "\x1b[48;5;" + bg.toString() + "m"
    result += text
    if(fg || bg) result += "\x1b[0m"
    return result
}

// theme for messages printed in terminal
// https://i.stack.imgur.com/KTSQa.png
export const theme = {
    code: (text) =>      colorize(text, 252, 238),
    margin: (text) =>    colorize(text, 229, 145),
    error: (text) =>     colorize(text, 196 , 52),
    ecode: (text) =>     colorize(text, 196, 238),
    action: (text) =>    colorize(text, 237),
    folder: (text) =>    colorize(text, 240),
    filename: (text) =>  colorize(text, 15),
    success: (text) =>   colorize(text, 40),
    failure: (text) =>   colorize(text, 15, 124),

    flags: (text) =>      colorize(text, 5),
    count: (text) =>      colorize(text, 15),
    start: (text) =>      colorize(text, 252, 233),
    filedir: (text) =>    colorize(text, 15),
    time: (text) =>       colorize(text, 41),
    link: (text) =>       colorize(text, 15),
    online: (text) =>     colorize(text, 40, 22)
}