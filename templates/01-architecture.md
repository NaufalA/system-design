# Solution Architecture: <Project Name>

## Diagram

```mermaid
flowchart LR
    client[Web/Mobile Client] --> gw[Public API Gateway]
    gw --> svcA[Service A]
    svcA --> db[(Database)]
    svcA --> bus([Event Bus])
    bus --> svcB[Service B]
```

## Component Details

<!-- For each component: responsibilities, tech, scaling/deployment notes. -->

## Communication Patterns

- Synchronous:
- Asynchronous:

## Data Flow

<!-- Brief description of how data moves end to end. -->

## Security & Auth

<!-- AuthZ/AuthN, gateway policies, secrets. -->

## Observability

<!-- Logging, metrics, tracing choices. -->
