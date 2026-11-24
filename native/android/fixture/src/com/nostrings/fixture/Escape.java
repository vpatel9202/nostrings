// An app that moves itself to the phone's own screen: opens the Phone activity
// on display 0 (the phone's screen) while this one stays where it was, as an
// app does when it opens a sign-in or system screen. Used by the smoke test
// to check nostrings's moved_to_phone_screen error.
package com.nostrings.fixture;

import android.app.Activity;
import android.app.ActivityOptions;
import android.content.Intent;
import android.os.Bundle;
import android.widget.TextView;

public class Escape extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        TextView t = new TextView(this);
        t.setText("on the phone's own screen");
        t.setTextSize(22);
        setContentView(t);
    }

    // Called from Main: start this activity on display 0.
    static void open(Activity from) {
        Intent i = new Intent(from, Escape.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_MULTIPLE_TASK);
        from.startActivity(i, ActivityOptions.makeBasic().setLaunchDisplayId(0).toBundle());
    }
}
