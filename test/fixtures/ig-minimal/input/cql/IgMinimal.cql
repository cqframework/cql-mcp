library IgMinimal version '1.0.0'

using FHIR version '4.0.1'

context Patient

define "Has Condition":
  exists [Condition]
