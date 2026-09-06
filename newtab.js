import { initWidgetPage } from "./shared/widgetPage.js"

const MAX_VISIBLE_TASKS = 10 // full New Tab page has room for the same limit the iOS large widget uses

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
