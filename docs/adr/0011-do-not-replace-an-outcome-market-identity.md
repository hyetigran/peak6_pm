# Do not replace an Outcome Market identity in V1

An empty Outcome Market may become terminally Abandoned before issuance, but V1 does not recreate the same ticker, Strike, and Trading Day identity after immutable asset accounts exist. Once issuance or order activity occurs, an erroneous market is permanently paused while recovery and Settlement remain available; avoiding revision registries and replacement seeds keeps the proof of concept smaller and preserves an auditable history.
