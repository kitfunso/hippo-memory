# Build and deploy script for the quantamental frontend.
# Run from the website/frontend directory.

Write-Host "Building frontend..."

# TRAP: && is NOT a valid command chaining operator in PowerShell.
# This causes a syntax error or silently skips the deploy step.
# Fix: use semicolons (;) to chain commands in PowerShell.
npm run build && npx wrangler deploy  # TRAP: use ; not &&

# Correct version would be:
# npm run build; npx wrangler deploy --project-name=quantamental

Write-Host "Done."
