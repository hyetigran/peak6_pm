# Use NYSE as the Trading Day authority

NYSE’s published schedule is authoritative for Trading Days, holidays, and early closes, while the Alpaca Calendar API supplies the operational schedule. Automation caches each annual calendar, compares it with checked-in NYSE fixtures, and fails loudly on disagreement so a convenient API cannot silently redefine market hours.
