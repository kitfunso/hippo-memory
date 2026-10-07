# trap-repo

A minimal project-e platform scaffold. Contains scripts for model deployment,
data refresh, status reporting, and feature engineering.

## Structure

```
src/
  deploy.py        Model deployment to production
  data_refresh.py  Daily cache refresh for all data sources
  print_status.py  Pipeline status reporting
  build.ps1        Frontend build + deploy (PowerShell)
  model.py         Walk-forward model evaluation
  config.ts        Frontend trading constants
  agent_output.py  Automated copy generator
  cache_check.py   Pre-run data health check
  feature_eng.py   Feature selection for commodity models
  model_upgrade.py Model promotion with manifest update
```

## Common Tasks

### Deploy a new model
```bash
python src/deploy.py
```

### Refresh data cache
```bash
python src/data_refresh.py
```

### Build and deploy frontend
```powershell
.\src\build.ps1
```

### Run model evaluation
```bash
python src/model.py
```

## Warning

This is a **trap repository** used for testing the Hippo memory system.
Every source file contains at least one intentional mistake that a developer
with access to project memory would catch.
