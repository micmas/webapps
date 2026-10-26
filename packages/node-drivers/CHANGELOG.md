# @neurodesk/node-drivers

## 0.3.0

### Minor Changes

- 5b5ff35: Add the `brainchop-mindgrab` command line, which runs the native brainchopC argv (`-o`, `--mask [PATH]`, `--border MM`, `--ct`, `--comply`) on MindGrab's CPU WebAssembly, so Linux containers can skull-strip for meica-rs `--moco` and fastprep without the native build.

## 0.2.0

### Minor Changes

- Move caller-pinned MindGrab and niimath Node drivers and their independent browser parity validation to dependency-free `@neurodesk/node-drivers`. Migrate every command line and remove the old runtime-support exports. Keep SynthSR and SynthStrip browser runtimes out of production Node deployments so portable brain-extraction and BrowserQC archives omit browser dependencies.
