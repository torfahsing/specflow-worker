/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const localWorkers = new Collection({
    name: "local_workers",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    fields: [
      { name: "worker_name", type: "text", required: true },
      { name: "status", type: "select", values: ["online", "busy", "offline"] },
      { name: "capabilities", type: "json" },
      { name: "last_heartbeat", type: "date" },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX `idx_local_workers_name` ON `local_workers` (`worker_name`)"
    ],
  });
  app.save(localWorkers);
}, (app) => {
  const localWorkers = app.findCollectionByNameOrId("local_workers");
  if (localWorkers) app.delete(localWorkers);
});
