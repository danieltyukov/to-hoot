/*
 * Step one, which asks for nothing.
 *
 * It exists to be read and moved past. The product claim it makes is that the
 * app is already finished for anyone who wants a task list with a timer, and
 * everything after this point is for people who want more than that. A wizard
 * that opened on a token field would be making the opposite claim.
 */
export function StepLocal() {
  return (
    <div className="step">
      <h2>Nothing to set up</h2>
      <p className="prose step-lead">
        to-hoot already works. Tasks, subtasks, estimates and the timer all run on this device
        and are stored on it. No account is needed and nothing is sent anywhere.
      </p>

      <ul className="step-list">
        <li>
          <span className="micro">Sync</span>
          <p className="prose">
            Keeps two devices in step through a private GitHub repository you own.
          </p>
        </li>
        <li>
          <span className="micro">Calendar</span>
          <p className="prose">
            Shows your day beside your tasks, and writes tracked time back to a separate
            calendar.
          </p>
        </li>
        <li>
          <span className="micro">Claude</span>
          <p className="prose">Lets Claude read and change your tasks for you.</p>
        </li>
      </ul>

      <p className="prose step-note">
        Each is optional and can be set up later from Settings. Skipping one leaves everything
        else working.
      </p>
    </div>
  );
}
