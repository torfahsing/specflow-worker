/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const tasksCol = app.findCollectionByNameOrId("tasks");
  const featuresCol = app.findCollectionByNameOrId("features");

  const runs = new Collection({
    name: "runs",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    fields: [
      {
        name: "task",
        type: "relation",
        collectionId: tasksCol ? tasksCol.id : "",
        maxSelect: 1,
      },
      {
        name: "feature",
        type: "relation",
        collectionId: featuresCol ? featuresCol.id : "",
        maxSelect: 1,
      },
      { name: "status", type: "select", values: ["running", "completed", "failed", "cancelled"] },
      { name: "input_tokens", type: "number" },
      { name: "output_tokens", type: "number" },
      { name: "cost_usd", type: "number" },
      { name: "error", type: "text" },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX `idx_runs_task` ON `runs` (`task`)"
    ],
  });
  app.save(runs);

  const runEvents = new Collection({
    name: "run_events",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    fields: [
      {
        name: "run",
        type: "relation",
        collectionId: runs.id,
        maxSelect: 1,
      },
      { name: "sequence", type: "number" },
      { name: "type", type: "select", values: ["text", "reasoning", "tool_call", "tool_result", "error"] },
      { name: "payload", type: "json" },
      { name: "created", type: "autodate", onCreate: true },
    ],
    indexes: [
      "CREATE INDEX `idx_run_events_run_sequence` ON `run_events` (`run`, `sequence`)"
    ],
  });
  app.save(runEvents);
}, (app) => {
  const runEvents = app.findCollectionByNameOrId("run_events");
  if (runEvents) app.delete(runEvents);

  const runs = app.findCollectionByNameOrId("runs");
  if (runs) app.delete(runs);
});
