# Use the primary listing market’s Official Close

Settlement uses the unadjusted Official Close published under the security’s primary listing-market rules rather than a generic provider daily-bar close. For the V1 MAG7 universe this is Nasdaq NOCP, and the Settlement Record identifies the Close Method, halt or contingency status, exchange publication time, provider observation and revision, and raw-response digest so a fallback value cannot masquerade as an ordinary close.
