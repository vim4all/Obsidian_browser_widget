import { initWidgetPage } from "./shared/widgetPage.js"

const MAX_VISIBLE_TASKS = 6 // popup has a hard height ceiling, unlike the New Tab page

initWidgetPage(
  {
    placeholder: document.getElementById("placeholder"),
    tasks: document.getElementById("tasks"),
    more: document.getElementById("more"),
    heatmap: document.getElementById("heatmap"),
    stranded: document.getElementById("stranded"),
    quickAdd: document.getElementById("quickAdd"),
    quickAddInput: document.getElementById("quickAddInput"),
    quickAddButton: document.getElementById("quickAddButton"),
    quickAddStatus: document.getElementById("quickAddStatus"),
  },
  document.getElementById("connectButton"),
  MAX_VISIBLE_TASKS
)
