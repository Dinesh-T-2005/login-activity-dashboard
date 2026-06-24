import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivityServiceService } from '../activity-service.service';

@Component({
  selector: 'app-login-history',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './login-history.component.html',
  styleUrl: './login-history.component.scss'
})
export class LoginHistoryComponent implements OnInit {

  loginHistory: any[] = [];
  data: any;




  constructor(private activityService: ActivityServiceService) { }

  ngOnInit(): void {

    let rawData: any;

    rawData = history.state;

    this.data = rawData?.state ? rawData.state : rawData;

    const userId = this.data?.userId;

    if (userId) {
      this.getLoginHistory(userId);
    }
  }

  // 🔥 MAIN API CALL
  getLoginHistory(userId: number): void {
    this.activityService.getDivisionRecruiter(userId).subscribe({
      next: (res) => {
        const raw = res.data?.[0]?.loginlogout;
        this.loginHistory = this.transformLoginHistory(raw);
        // this.updateTodaySummary();
      },
      error: (err) => {
        console.error('Login history error:', err);
      }
    });
  }

  // 🔥 CORE TRANSFORM LOGIC
  transformLoginHistory(loginlogoutStr: string): any[] {
    if (!loginlogoutStr) return [];

    const parsed = JSON.parse(loginlogoutStr);
    const result: any[] = [];

    parsed.forEach((day: any) => {
      let loginCount = 0;
      let totalMinutes = 0;
      let isActive = false;

      const sessions: any[] = [];

      const seenLogins = new Set<string>();

      [...day.sessions].reverse().forEach((s: any) => {
        if (!s.login) return;

        // 🔥 ONLY logged-out sessions
        if (!s.logout) return;

        // ❌ ignore refresh logs
        if (s.login === s.logout) return;

        // ❌ ignore duplicate login times (keep last one)
        if (seenLogins.has(s.login)) return;
        seenLogins.add(s.login);

        const loginMin = this.timeToMinutes(s.login);
        const logoutMin = this.timeToMinutes(s.logout);

        const duration = logoutMin - loginMin;

        // ❌ ignore < 1 min
        if (duration < 1) return;

        // ✅ valid login
        loginCount++;
        totalMinutes += duration;

        sessions.unshift({
          login: s.login,
          logout: s.logout,
          duration: `${duration} mins`,
          isActive: false
        });
      });


      result.push({
        date: day.date,
        loginCount,
        totalDuration: this.formatMinutes(totalMinutes),
        isActive,
        expanded: false,
        sessions
      });
    });

    return result;
  }

  // 🔧 HELPERS
  timeToMinutes(timeStr: string): number {
    const [time, period] = timeStr.split(' ');
    let [h, m] = time.split(':').map(Number);

    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;

    return h * 60 + m;
  }

  formatMinutes(total: number): string {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${h}h ${m}m`;
  }
}
