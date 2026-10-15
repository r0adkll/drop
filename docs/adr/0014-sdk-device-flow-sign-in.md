# The SDK signs Testers in for private Products

For a private Product, the SDK signs the Tester in once per install through GitHub's device flow
(the app shows a code to enter on github.com), and sends the resulting Drop token with every Update
check; Drop keeps rechecking that the Tester can still read the repository. A Product key stamped
into the APK from a CI secret would have needed no sign-in, but then anyone holding the APK could
fetch every newer Build, so "private" would mean "has the APK" rather than "can read the
repository".
