"""Print-only helper class ``aCustTestFeature`` and its alias ``aTestFeature``.

The class groups three static methods. Each takes no arguments, writes its
result to standard output with ``print`` and returns ``None``:

* ``number2026721`` prints the integers 1 to 10, one per line.
* ``tebahpla2026721`` prints the lowercase alphabet backwards, ``z`` to ``a``.
* ``oneWeek2026721`` prints the local date seven days after today, ISO 8601.

``aTestFeature`` is an alias bound to the very same class object as
``aCustTestFeature``, so either name reaches one implementation.

Usage::

    >>> from a_cust_test_feature import aCustTestFeature
    >>> aCustTestFeature.tebahpla2026721()
    zyxwvutsrqponmlkjihgfedcba

Importing this module defines names only and prints nothing.
"""

# ``date`` is imported by name on purpose: the module-level name ``date`` is
# the single route by which ``oneWeek2026721`` reads today, so tests can
# replace it with ``mock.patch.object(a_cust_test_feature, 'date', ...)``
# without patching ``datetime.date`` globally. Do not switch to
# ``import datetime``; that would remove the patch target.
from datetime import date, timedelta
from string import ascii_lowercase

__all__ = ['aCustTestFeature', 'aTestFeature']


# The class, method and alias names are the user's identifiers, kept verbatim
# (including casing) even though they depart from PEP 8 naming.
class aCustTestFeature:
    """Stateless group of print-only static methods.

    Every method can be called on the class, on the alias or on an instance;
    the three forms are equivalent::

        aCustTestFeature.number2026721()
        aTestFeature.number2026721()
        aCustTestFeature().number2026721()
    """

    @staticmethod
    def number2026721():
        """Print the integers 1 through 10, both bounds included.

        Each value is a decimal integer on its own line, so the exact output
        is ``'1\\n2\\n3\\n4\\n5\\n6\\n7\\n8\\n9\\n10\\n'`` (10 lines).
        """
        for number in range(1, 11):
            print(number)

    @staticmethod
    def tebahpla2026721():
        """Print the 26 lowercase ASCII letters in reverse order on one line.

        The letters run ``z`` to ``a`` with no separator, so the exact output
        is ``'zyxwvutsrqponmlkjihgfedcba\\n'``.
        """
        print(ascii_lowercase[::-1])

    @staticmethod
    def oneWeek2026721():
        """Print the local calendar date one week after today, ISO 8601.

        Today is the host's local date from ``date.today()``; seven days are
        added with ``timedelta(weeks=1)``, which handles month ends, year
        ends and leap years. The output is ``'YYYY-MM-DD\\n'``; for example,
        when today is 2026-10-05 it prints ``2026-10-12``.
        """
        print((date.today() + timedelta(weeks=1)).isoformat())


# A plain alias, not a subclass or copy: ``aTestFeature is aCustTestFeature``
# holds and ``__name__`` stays ``'aCustTestFeature'``, so the two names can
# never drift apart.
aTestFeature = aCustTestFeature
