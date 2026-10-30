library MainMeasure version '1.0.0'

using FHIR version '4.0.1'

include CommonHelper version '1.0.0' called Helper

define "IsOverThreshold":
  Helper."Threshold" > 40

define "Computed":
  Helper.AddTen(5)
