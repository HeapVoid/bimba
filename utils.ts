function colorize(text:string, fg?:number, bg?:number) {
    let result = ''
    if(fg) result += "\x1b[38;5;" + fg.toString() + "m"
    if(bg) result += "\x1b[48;5;" + bg.toString() + "m"
    result += text
    if(fg || bg) result += "\x1b[0m"
    return result
}

// const theme = {
//     action: ansis.fg(237),
//     folder: ansis.fg(240),
//     filename: ansis.fg(15),
//     success: ansis.fg(40),
//     failure: ansis.fg(15).bg(124),
//   };

//   // set color theme for an error message
//   const colors = {
//     code: ansis.fg(252).bg(238),
//     margin: ansis.fg(229).bg(145),
//     error: ansis.fg(196).bg(52),
//     ecode: ansis.fg(196).bg(238).bold,
//   };

// theme for messages printed in terminal
// https://i.stack.imgur.com/KTSQa.png
export const theme = {
    code: (text:string) =>      colorize(text, 252, 238),
    margin: (text:string) =>    colorize(text, 229, 145),
    error: (text:string) =>     colorize(text, 196 , 52),
    ecode: (text:string) =>     colorize(text, 196, 238),
    action: (text:string) =>    colorize(text, 237),
    folder: (text:string) =>    colorize(text, 240),
    filename: (text:string) =>  colorize(text, 15),
    success: (text:string) =>   colorize(text, 40),
    failure: (text:string) =>   colorize(text, 15, 124),

    flags: (text:string) =>      colorize(text, 5),
    count: (text:string) =>      colorize(text, 15),
    start: (text:string) =>      colorize(text, 252, 233),
    filedir: (text:string) =>    colorize(text, 15),
    time: (text:string) =>       colorize(text, 41),
    link: (text:string) =>       colorize(text, 15),
    online: (text:string) =>     colorize(text, 40, 22)
}