/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const tasks = app.findCollectionByNameOrId("tasks");
  const localWorkers = app.findCollectionByNameOrId("local_workers");
  if (tasks) {
    if (!tasks.fields.getByName("assigned_worker")) {
      tasks.fields.add(new RelationField({
        name: "assigned_worker",
        collectionId: localWorkers ? localWorkers.id : "",
        required: false,
        maxSelect: 1,
      }));
    }
    if (!tasks.fields.getByName("prompt")) {
      tasks.fields.add(new TextField({
        name: "prompt",
        required: false,
      }));
    }
    if (!tasks.fields.getByName("provider_command")) {
      tasks.fields.add(new TextField({
        name: "provider_command",
        required: false,
      }));
    }
    if (!tasks.fields.getByName("model")) {
      tasks.fields.add(new TextField({
        name: "model",
        required: false,
      }));
    }
    if (!tasks.fields.getByName("allowed_tools")) {
      tasks.fields.add(new JSONField({
        name: "allowed_tools",
        required: false,
      }));
    }
    if (!tasks.fields.getByName("timeout")) {
      tasks.fields.add(new NumberField({
        name: "timeout",
        required: false,
      }));
    }
    app.save(tasks);
  }
}, (app) => {
  const tasks = app.findCollectionByNameOrId("tasks");
  if (tasks) {
    const fieldNames = [
      "assigned_worker",
      "prompt",
      "provider_command",
      "model",
      "allowed_tools",
      "timeout",
    ];
    for (const name of fieldNames) {
      const field = tasks.fields.getByName(name);
      if (field) {
        tasks.fields.removeByName(name);
      }
    }
    app.save(tasks);
  }
});
